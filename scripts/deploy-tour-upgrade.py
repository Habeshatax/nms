#!/usr/bin/env python3
"""Deploy a pinned nursery release on its existing VPS, retaining the old container."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request


def run(*args, capture=False, check=True):
    return subprocess.run(args, check=check, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def inspect(name):
    return json.loads(run('docker', 'inspect', name, capture=True).stdout)[0]


HEALTH = r'''
(async () => {
 for (const path of ['/', '/contact', '/sitemap.xml']) {
  const response = await fetch('http://127.0.0.1:3000' + path);
  if (response.status !== 200) throw new Error('Page check failed');
 }
 const denied = await fetch('http://127.0.0.1:3000/api/tour-emails', {method:'POST'});
 if (denied.status !== 401) throw new Error('Worker authorization check failed');
})().catch(() => process.exit(1));
'''
SCHEMA = r'''
(async () => {
 require('@next/env').loadEnvConfig('/app');
 const env = process.env;
 if (env.TOUR_MANAGEMENT_ENABLED !== 'true' || env.TOUR_EMAIL_MODE !== 'disabled') throw 0;
 const url = env.NEXT_PUBLIC_SUPABASE_URL;
 if (new URL(url).hostname !== 'wupuozrkguoxpoftgwnc.supabase.co') throw 0;
 const key = env.SUPABASE_SERVICE_ROLE_KEY;
 if (!key) throw 0;
 const headers = {apikey:key, Authorization:'Bearer '+key};
 for (const path of ['chat_threads?select=id,tour_status,tour_revision&limit=0',
                     'tour_email_outbox?select=id,state&limit=0']) {
  const response = await fetch(url+'/rest/v1/'+path, {headers});
  if (response.status !== 200) throw 0;
 }
 const schema = await fetch(url+'/rest/v1/', {headers:{...headers,Accept:'application/openapi+json'}});
 if (!schema.ok) throw 0;
 const document = await schema.json();
 for (const rpc of ['submit_tour_request','update_tour_request','claim_tour_email']) {
  if (!document.paths?.['/rpc/'+rpc]) throw 0;
 }
})().catch(() => { console.error('Tour schema or runtime configuration check failed'); process.exit(1); });
'''


def wait_for_app(name):
    for _ in range(40):
        if run('docker', 'exec', name, 'node', '-e', HEALTH, capture=True, check=False).returncode == 0:
            return
        time.sleep(3)
    raise RuntimeError('Application startup checks failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision', required=True, help='Exact merged Git commit SHA')
    options = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', options.revision):
        raise RuntimeError('A full commit SHA is required')
    os.umask(0o077)
    source = Path('/root/nms')
    os.chdir(source)
    old = inspect('nms-app')
    if not old['State']['Running']:
        raise RuntimeError('The existing nms-app must be running')
    host, config = old['HostConfig'], old['Config']
    # The known nursery setup has no mounts or host ports. Stop safely on topology drift.
    if old.get('Mounts') or host.get('PortBindings') or host.get('Privileged') or host.get('Devices'):
        raise RuntimeError('Container topology differs from the reviewed setup; nothing changed')
    if host.get('ReadonlyRootfs') or host.get('CapAdd') or host.get('SecurityOpt'):
        raise RuntimeError('Custom container security settings need to be preserved manually; nothing changed')
    networks = list(old['NetworkSettings']['Networks'])
    if set(networks) != {'frappe_default', 'frappe_docker_default'}:
        raise RuntimeError('Container networks differ from the reviewed setup; nothing changed')
    if run('git', 'status', '--porcelain', '--untracked-files=no', capture=True).stdout.strip():
        raise RuntimeError('Tracked source changes exist; commit or preserve them first')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    backup = Path('/root/nms-deploy-backups') / ('tours-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'container.json').write_text(json.dumps(old, indent=2))
    (backup / 'source-revision.txt').write_text(run('git', 'rev-parse', 'HEAD', capture=True).stdout)
    for filename in ('.env', '.env.local', '.env.production', '.env.production.local'):
        if (source / filename).is_file():
            shutil.copy2(source / filename, backup / filename)
            (backup / filename).chmod(0o600)
    if not (source / '.env').is_file():
        raise RuntimeError('Expected /root/nms/.env is missing; nothing changed')
    run('git', 'fetch', 'https://github.com/Habeshatax/nms.git', options.revision)
    fetched = run('git', 'rev-parse', 'FETCH_HEAD', capture=True).stdout.strip()
    if fetched != options.revision:
        raise RuntimeError('Fetched revision does not match the pinned release')
    run('git', 'merge-base', '--is-ancestor', 'HEAD', fetched)
    run('git', 'merge', '--ff-only', fetched)
    image = 'nms-app:tours-' + stamp
    run('docker', 'image', 'tag', old['Image'], 'nms-app:before-tours-' + stamp)
    # Use the same Webpack build path validated in the isolated production build.
    dockerfile = backup / 'Dockerfile'
    original = (source / 'Dockerfile').read_text()
    if original.count('RUN npm run build') != 1:
        raise RuntimeError('Dockerfile build step changed; review before deploying')
    dockerfile.write_text(original.replace('RUN npm run build', 'RUN npm run build -- --webpack'))
    print('Building the pinned release. Existing website is still running.', flush=True)
    run('docker', 'build', '-t', image, '-f', str(dockerfile), '.')

    candidate, pending = 'nms-tour-check-' + stamp, 'nms-tour-new-' + stamp
    rollback = 'nms-app-before-tours-' + stamp
    values = dict(item.split('=', 1) for item in config.get('Env', []) if '=' in item)
    values.update(TOUR_MANAGEMENT_ENABLED='true', TOUR_EMAIL_MODE='disabled')

    def create(name, public):
        args = ['docker', 'create', '--name', name, '--network', networks[0]]
        for key, value in values.items():
            if not public and key in ('VIRTUAL_HOST', 'LETSENCRYPT_HOST'):
                value = ''
            args += ['--env', key + '=' + value]
        if public:
            for key, value in (config.get('Labels') or {}).items():
                args += ['--label', key + '=' + value]
            restart = host.get('RestartPolicy', {}).get('Name') or 'no'
            retries = host.get('RestartPolicy', {}).get('MaximumRetryCount', 0)
            args += ['--restart', restart + (':' + str(retries) if restart == 'on-failure' and retries else '')]
        for key, flag in [('Memory', '--memory'), ('MemorySwap', '--memory-swap'), ('CpuShares', '--cpu-shares')]:
            if host.get(key):
                args += [flag, str(host[key])]
        if host.get('NanoCpus'):
            args += ['--cpus', str(host['NanoCpus'] / 1_000_000_000)]
        if config.get('WorkingDir'):
            args += ['--workdir', config['WorkingDir']]
        if config.get('User'):
            args += ['--user', config['User']]
        args += [image] + (config.get('Cmd') or [])
        run(*args, capture=True)
        for network in networks[1:]:
            run('docker', 'network', 'connect', network, name)

    old_stopped = False
    try:
        create(candidate, False)
        run('docker', 'start', candidate, capture=True)
        wait_for_app(candidate)
        run('docker', 'exec', candidate, 'node', '-e', SCHEMA)
        print('Candidate pages, schema and worker access checks passed.', flush=True)
        run('docker', 'rm', '-f', candidate, capture=True)
        create(pending, True)
        # Set the flag before stopping so a failed stop is also recovered safely.
        old_stopped = True
        run('docker', 'stop', '--time', '30', 'nms-app', capture=True)
        run('docker', 'rename', 'nms-app', rollback)
        run('docker', 'rename', pending, 'nms-app')
        run('docker', 'start', 'nms-app', capture=True)
        wait_for_app('nms-app')
        run('docker', 'exec', 'nms-app', 'node', '-e', SCHEMA)
        for attempt in range(20):
            try:
                request = urllib.request.Request('https://bubblydnursery.co.uk/contact?release=' + stamp,
                                                 headers={'Cache-Control': 'no-cache'})
                with urllib.request.urlopen(request, timeout=15) as response:
                    if response.status == 200:
                        break
            except Exception:
                pass
            if attempt == 19:
                raise RuntimeError('Public contact page check failed')
            time.sleep(3)
    except BaseException:
        run('docker', 'rm', '-f', candidate, capture=True, check=False)
        if old_stopped:
            current = inspect(old['Id'])
            if current['Name'] != '/nms-app':
                run('docker', 'rm', '-f', 'nms-app', capture=True, check=False)
                run('docker', 'rename', old['Id'], 'nms-app')
            run('docker', 'start', 'nms-app', capture=True)
            print('Deployment failed. Previous container was restarted.', flush=True)
        run('docker', 'rm', '-f', pending, capture=True, check=False)
        raise
    (backup / 'release.json').write_text(json.dumps({'revision': fetched, 'rollback': rollback, 'image': image}))
    print('Tour upgrade deployed. Public contact page check passed.')
    print('Tour management: enabled. Email sending: disabled, previews available.')
    print('Rollback container:', rollback)
    print('Backup:', backup)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print subprocess arguments, which can contain container environment secrets.
        if isinstance(error, subprocess.CalledProcessError):
            print('Stopped because a command failed. See the preceding output; no secrets were printed.', file=sys.stderr)
        else:
            print(str(error), file=sys.stderr)
        sys.exit(1)
