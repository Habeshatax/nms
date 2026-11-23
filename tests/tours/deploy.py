"""Offline release-switch tests. No Docker, network or production files are used."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('deploy', ROOT / 'scripts/deploy-tour-upgrade.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
SHA = 'a' * 40


class DeploymentTests(unittest.TestCase):
    def exercise(self, failure=None):
        commands = []
        current = {'name': '/nms-app'}
        old = {'Id': 'old-id', 'Image': 'sha256:old', 'Name': '/nms-app', 'State': {'Running': True},
               'Mounts': [], 'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}},
               'Config': {'Env': ['VIRTUAL_HOST=bubblydnursery.co.uk'], 'Cmd': ['npm', 'start']},
               'NetworkSettings': {'Networks': {'frappe_default': {}, 'frappe_docker_default': {}}}}
        def fake_inspect(name):
            return {**old, 'Name': current['name']}
        def fake_run(*args, **kwargs):
            commands.append(args)
            if failure == 'build' and args[:2] == ('docker', 'build'):
                raise subprocess.CalledProcessError(1, ['redacted'])
            if failure == 'schema' and args[:2] == ('docker', 'exec'):
                raise subprocess.CalledProcessError(1, ['redacted'])
            if args[:2] == ('docker', 'rename'):
                if failure == 'rename' and args[2] == 'nms-app':
                    raise subprocess.CalledProcessError(1, ['redacted'])
                if args[2] in ('nms-app', 'old-id'):
                    current['name'] = '/' + args[3]
            if failure == 'start' and args[:3] == ('docker', 'start', 'nms-app') and current['name'] != '/nms-app':
                # Fail only the first new-container start, then permit rollback start.
                if sum(c[:3] == ('docker', 'start', 'nms-app') for c in commands) == 1:
                    raise subprocess.CalledProcessError(1, ['redacted'])
            stdout = SHA + '\n' if args[:3] == ('git', 'rev-parse', 'FETCH_HEAD') else ''
            return subprocess.CompletedProcess(args, 0, stdout=stdout)
        class PublicResponse:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
        saved_cwd = deploy.os.getcwd()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary) / 'nms'
                source.mkdir()
                (source / '.env').write_text('FICTIONAL=1\n')
                (source / 'Dockerfile').write_text('FROM node:22-alpine\nRUN npm run build\n')
                def fake_path(value):
                    if value == '/root/nms': return source
                    if value == '/root/nms-deploy-backups': return Path(temporary) / 'backups'
                    return Path(value)
                with patch.object(deploy, 'Path', fake_path), patch.object(deploy, 'inspect', fake_inspect), \
                     patch.object(deploy, 'run', fake_run), patch.object(deploy, 'wait_for_app'), \
                     patch.object(deploy.urllib.request, 'urlopen', return_value=PublicResponse()), \
                     patch.object(sys, 'argv', ['deploy.py', '--revision', SHA]):
                    if failure:
                        with self.assertRaises(subprocess.CalledProcessError): deploy.main()
                    else:
                        deploy.main()
        finally:
            deploy.os.chdir(saved_cwd)
        return commands

    def test_success_starts_candidate_before_stopping_old(self):
        commands = self.exercise()
        start_candidate = next(i for i,c in enumerate(commands) if c[:2] == ('docker','start') and c[2].startswith('nms-tour-check'))
        stop_old = next(i for i,c in enumerate(commands) if c[:2] == ('docker','stop'))
        self.assertLess(start_candidate, stop_old)
        self.assertFalse(any(c[:3] == ('docker','rm','old-id') for c in commands))

    def test_build_failure_keeps_live_container_running(self):
        commands = self.exercise('build')
        self.assertFalse(any(c[:2] == ('docker','stop') for c in commands))

    def test_schema_failure_keeps_live_container_running(self):
        commands = self.exercise('schema')
        self.assertFalse(any(c[:2] == ('docker','stop') for c in commands))

    def test_rename_failure_restarts_original_name(self):
        commands = self.exercise('rename')
        self.assertIn(('docker','start','nms-app'), commands)
        self.assertNotIn(('docker','rm','-f','nms-app'), commands)

    def test_new_start_failure_restores_old_container(self):
        commands = self.exercise('start')
        self.assertIn(('docker','rename','old-id','nms-app'), commands)
        self.assertEqual(sum(c == ('docker','start','nms-app') for c in commands), 2)


if __name__ == '__main__': unittest.main()
