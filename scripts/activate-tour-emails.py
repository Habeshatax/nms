#!/usr/bin/env python3
"""Activate verified nursery booking emails on the existing VPS with rollback."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request

APP = 'nms-app'
HOST_ENV = Path('/root/nms/.env')
CRON = Path('/etc/cron.d/nms-tour-emails')
RUNNER = r'''require('@next/env').loadEnvConfig('/app');
(async () => {
 if (process.env.TOUR_EMAIL_MODE !== 'send' || !process.env.TOUR_EMAIL_CRON_SECRET) throw 0;
 const response = await fetch('http://127.0.0.1:3000/api/tour-emails', {
  method:'POST', headers:{Authorization:'Bearer '+process.env.TOUR_EMAIL_CRON_SECRET},
  signal:AbortSignal.timeout(150000)
 });
 if (!response.ok) throw 0;
 const data = await response.json();
 if (data.mode !== 'send') throw 0;
 console.log(new Date().toISOString(), JSON.stringify(data));
})().catch(() => { console.error('Tour email worker unavailable; check protected server logs.'); process.exit(1); });
'''
CHECK = r'''require('@next/env').loadEnvConfig('/app');
(async () => {
 const env=process.env;
 if (env.TOUR_MANAGEMENT_ENABLED !== 'true' || env.TOUR_EMAIL_MODE !== 'send' ||
     !env.TOUR_EMAIL_API_KEY?.startsWith('re_') || !env.TOUR_EMAIL_CRON_SECRET ||
     env.TOUR_EMAIL_FROM !== 'Bubbly Day Nursery <bookings@updates.bubblydnursery.co.uk>' ||
     new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname !== 'wupuozrkguoxpoftgwnc.supabase.co') throw 0;
 for (const path of ['/', '/contact']) {
  const response=await fetch('http://127.0.0.1:3000'+path,{signal:AbortSignal.timeout(10000)});
  if (response.status !== 200) throw 0;
 }
 const denied=await fetch('http://127.0.0.1:3000/api/tour-emails',{method:'POST'});
 if (denied.status !== 401) throw 0;
 const queued=await fetch(env.NEXT_PUBLIC_SUPABASE_URL+
  '/rest/v1/tour_email_outbox?select=snapshot&state=in.(PENDING,SENDING)&limit=1000',
  {headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY}});
 if (!queued.ok) throw 0;
 const jobs=await queued.json();
 if (jobs.some(job=>/\.invalid$/i.test(job.snapshot?.email || '') ||
     /^SYSTEM TEST/i.test(job.snapshot?.name || ''))) throw 0;
})().catch(() => process.exit(1));
'''


def run(*args, capture=False, check=True):
    return subprocess.run(args, text=True, check=check,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def inspect(name):
    return json.loads(run('docker', 'inspect', name, capture=True).stdout)[0]


def update_env(text, settings):
    for name, value in settings.items():
        text = re.sub(r'(?m)^\s*(?:export\s+)?' + re.escape(name) + r'\s*=.*$', '', text)
        text = text.rstrip() + '\n' + name + '=' + json.dumps(value) + '\n'
    return text


def wait_for_app(name):
    for _ in range(30):
        if run('docker', 'exec', name, 'node', '-e', CHECK, capture=True, check=False).returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError('Candidate configuration/pages/queue checks failed; live sending was not activated')


def main():
    os.umask(0o077)
    old = inspect(APP)
    host, config = old['HostConfig'], old['Config']
    env = dict(item.split('=', 1) for item in config.get('Env', []) if '=' in item)
    if env.get('TOUR_EMAIL_MODE') == 'send':
        raise RuntimeError('Sending is already enabled. Inspect the existing scheduler before rerunning')
    if env.get('TOUR_EMAIL_MODE') != 'disabled' or not old['State']['Running']:
        raise RuntimeError('Expected the running nursery app with email mode disabled')
    if old.get('Mounts') or host.get('PortBindings') or host.get('Privileged') or host.get('Devices'):
        raise RuntimeError('Container topology has changed; review it before activating')
    if host.get('ReadonlyRootfs') or host.get('CapAdd') or host.get('SecurityOpt'):
        raise RuntimeError('Custom container security settings need manual preservation')
    networks = list(old['NetworkSettings']['Networks'])
    if set(networks) != {'frappe_default', 'frappe_docker_default'}:
        raise RuntimeError('Unexpected container networks')
    if CRON.exists():
        raise RuntimeError('A nursery email scheduler already exists; inspect it before rerunning')
    docker_path, flock_path = shutil.which('docker'), shutil.which('flock')
    if not docker_path or not flock_path or not CRON.parent.is_dir():
        raise RuntimeError('Docker, flock and /etc/cron.d must be available')
    if run('systemctl', 'is-active', '--quiet', 'cron', capture=True, check=False).returncode:
        raise RuntimeError('The VPS cron service is not running. Nothing changed; report this message')
    original_host = HOST_ENV.read_text()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    backup = Path('/root/nms-deploy-backups') / ('email-live-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'container.json').write_text(json.dumps(old, indent=2))
    (backup / 'host.env').write_text(original_host)
    run('docker', 'cp', APP + ':/app/.env', str(backup / 'container.env'), capture=True)
    settings = {'TOUR_EMAIL_MODE': 'send', 'TOUR_MANAGEMENT_ENABLED': 'true',
                'TOUR_EMAIL_CRON_SECRET': secrets.token_urlsafe(48)}
    prepared = backup / 'prepared.env'
    prepared.write_text(update_env((backup / 'container.env').read_text(), settings))
    worker = backup / 'process-tour-emails.cjs'
    worker.write_text(RUNNER)
    candidate, pending = 'nms-email-check-' + stamp, 'nms-email-new-' + stamp
    rollback = 'nms-app-before-email-live-' + stamp

    def create(name, public):
        values = {**env, 'TOUR_EMAIL_MODE': 'send', 'TOUR_MANAGEMENT_ENABLED': 'true'}
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
        for key, flag in [('WorkingDir', '--workdir'), ('User', '--user')]:
            if config.get(key):
                args += [flag, config[key]]
        args += [old['Image']] + (config.get('Cmd') or [])
        run(*args, capture=True)
        for network in networks[1:]:
            run('docker', 'network', 'connect', network, name)
        run('docker', 'cp', str(prepared), name + ':/app/.env', capture=True)
        run('docker', 'cp', str(worker), name + ':/app/scripts/process-tour-emails.cjs', capture=True)

    switched = False
    try:
        create(candidate, False)
        run('docker', 'start', candidate, capture=True)
        wait_for_app(candidate)
        run('docker', 'rm', '-f', candidate, capture=True)
        print('Candidate configuration, pages, worker protection and queue checks passed.', flush=True)
        create(pending, True)
        switched = True
        run('docker', 'stop', '--time', '30', APP, capture=True)
        run('docker', 'rename', APP, rollback)
        run('docker', 'rename', pending, APP)
        run('docker', 'start', APP, capture=True)
        wait_for_app(APP)
        for attempt in range(15):
            try:
                request = urllib.request.Request('https://bubblydnursery.co.uk/contact?email_release=' + stamp,
                                                 headers={'Cache-Control': 'no-cache'})
                with urllib.request.urlopen(request, timeout=15) as response:
                    if response.status == 200:
                        break
            except Exception:
                pass
            if attempt == 14:
                raise RuntimeError('Public contact page check failed')
            time.sleep(2)
        run('docker', 'exec', APP, 'node', '/app/scripts/process-tour-emails.cjs')
        HOST_ENV.write_text(update_env(original_host, settings))
        HOST_ENV.chmod(0o600)
        log = Path('/var/log/nms-tour-emails.log')
        log.touch(mode=0o600, exist_ok=True)
        CRON.write_text('# Nursery tour email retries; managed by activate-tour-emails.py\n'
                        'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
                        '* * * * * root ' + flock_path + ' -n /run/lock/nms-tour-emails.lock ' + docker_path +
                        ' exec nms-app node /app/scripts/process-tour-emails.cjs >>/var/log/nms-tour-emails.log 2>&1\n')
        CRON.chmod(0o644)
        (backup / 'release.json').write_text(json.dumps({'rollback': rollback, 'image': old['Image']}))
    except BaseException:
        if CRON.exists():
            CRON.unlink()
        HOST_ENV.write_text(original_host)
        HOST_ENV.chmod(0o600)
        run('docker', 'rm', '-f', candidate, capture=True, check=False)
        if switched:
            if inspect(old['Id'])['Name'] != '/' + APP:
                run('docker', 'rm', '-f', APP, capture=True, check=False)
                run('docker', 'rename', old['Id'], APP)
            run('docker', 'start', APP, capture=True)
        run('docker', 'rm', '-f', pending, capture=True, check=False)
        print('Activation failed. Previous app and disabled email configuration restored.', flush=True)
        raise
    print('Automatic nursery booking emails ENABLED.')
    print('Scheduled retries: every minute. Test notifications remain excluded.')
    print('Rollback container:', rollback)
    print('Backup:', backup)


if __name__ == '__main__':
    try:
        with open('/run/lock/nms-tour-email-activation.lock', 'w') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            main()
    except subprocess.CalledProcessError:
        print('A deployment command failed; configuration was preserved or restored. No secrets were printed.', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
