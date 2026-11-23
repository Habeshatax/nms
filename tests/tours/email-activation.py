"""Offline activation regression tests; no Docker, network, or production files."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('activation', ROOT / 'scripts/activate-tour-emails.py')
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)
FAKE_KEY = 're_fictional_test_key'
ORIGINAL = 'TOUR_EMAIL_API_KEY=' + FAKE_KEY + '\nTOUR_EMAIL_MODE=disabled\n'


class ActivationTests(unittest.TestCase):
    def exercise(self, failure=None, cron_active=True, existing_cron=False, mode='disabled'):
        commands = []
        old_name = {'value': '/nms-app'}
        old = {'Id':'old-id','Image':'sha256:existing-image','State':{'Running':True},'Mounts':[],
               'HostConfig':{'RestartPolicy':{'Name':'unless-stopped'}},
               'Config':{'Env':['TOUR_EMAIL_MODE='+mode,'VIRTUAL_HOST=bubblydnursery.co.uk'],
                         'Labels':{'nursery':'yes'},'Cmd':['npm','start']},
               'NetworkSettings':{'Networks':{'frappe_default':{},'frappe_docker_default':{}}}}
        def inspect(name): return {**old,'Name':old_name['value']}
        def run(*args, **kwargs):
            commands.append(args)
            if args[:3] == ('systemctl','is-active','--quiet'):
                return subprocess.CompletedProcess(args,0 if cron_active else 1,stdout='')
            if args[:3] == ('docker','cp','nms-app:/app/.env'):
                Path(args[3]).write_text(ORIGINAL)
            if args[:2] == ('docker','rename'):
                if args[2] in ('nms-app','old-id'): old_name['value']='/'+args[3]
            if failure == 'start' and args == ('docker','start','nms-app'):
                if sum(c == args for c in commands) == 1:
                    raise subprocess.CalledProcessError(1,['redacted'])
            if failure == 'worker' and args == ('docker','exec','nms-app','node','/app/scripts/process-tour-emails.cjs'):
                raise subprocess.CalledProcessError(1,['redacted'])
            return subprocess.CompletedProcess(args,0,stdout='')
        def wait(name):
            if failure == 'candidate': raise RuntimeError('simulated candidate failure')
        class PublicResponse:
            status=200
            def __enter__(self): return self
            def __exit__(self,*args): pass
        with tempfile.TemporaryDirectory() as temporary:
            temporary=Path(temporary)
            host=temporary/'host.env'; host.write_text(ORIGINAL)
            cron=temporary/'cron.d'/'nms-tour-emails';cron.parent.mkdir()
            if existing_cron: cron.write_text('preserve existing scheduler\n')
            def fake_path(value):
                if value == '/root/nms-deploy-backups': return temporary/'backups'
                if value == '/var/log/nms-tour-emails.log': return temporary/'worker.log'
                return Path(value)
            with patch.object(activation,'HOST_ENV',host),patch.object(activation,'CRON',cron), \
                 patch.object(activation,'Path',fake_path),patch.object(activation,'inspect',inspect), \
                 patch.object(activation,'run',run),patch.object(activation,'wait_for_app',wait), \
                 patch.object(activation.shutil,'which',side_effect=lambda name:'/usr/bin/'+name), \
                 patch.object(activation.urllib.request,'urlopen',return_value=PublicResponse()):
                if failure or not cron_active or existing_cron or mode != 'disabled':
                    with self.assertRaises((RuntimeError,subprocess.CalledProcessError)): activation.main()
                else: activation.main()
            prepared=list((temporary/'backups').glob('*/prepared.env'))
            result={'commands':commands,'host':host.read_text(),
                    'cron':cron.read_text() if cron.exists() else None,
                    'prepared':prepared[0].read_text() if prepared else '',
                    'name':old_name['value'],
                    'cron_mode':cron.stat().st_mode & 0o777 if cron.exists() else None}
        return result

    def test_update_preserves_key_and_removes_duplicate_flags(self):
        text=activation.update_env(ORIGINAL+'export TOUR_EMAIL_MODE="test"\n',{'TOUR_EMAIL_MODE':'send'})
        self.assertEqual(text.count('TOUR_EMAIL_MODE='),1)
        self.assertIn(FAKE_KEY,text)
        self.assertIn('TOUR_EMAIL_MODE="send"',text)

    def test_success_preserves_image_and_checks_candidate_before_switch(self):
        result=self.exercise(); commands=result['commands']
        self.assertFalse(any(c[:2] == ('docker','build') for c in commands))
        creates=[c for c in commands if c[:2] == ('docker','create')]
        self.assertEqual(len(creates),2)
        self.assertTrue(all('sha256:existing-image' in c and 'TOUR_EMAIL_MODE=send' in c for c in creates))
        self.assertLess(next(i for i,c in enumerate(commands) if c[:2] == ('docker','start') and 'nms-email-check' in c[2]),
                        next(i for i,c in enumerate(commands) if c[:2] == ('docker','stop')))

    def test_scheduler_and_env_contain_correct_mode_and_no_exposed_key(self):
        result=self.exercise()
        self.assertIn('TOUR_EMAIL_MODE="send"',result['host'])
        self.assertIn('TOUR_EMAIL_CRON_SECRET=',result['prepared'])
        self.assertIn('/usr/bin/flock -n',result['cron'])
        self.assertIn('* * * * * root',result['cron'])
        self.assertEqual(result['cron_mode'],0o644)
        self.assertNotIn(FAKE_KEY,result['cron'])
        self.assertFalse(any(FAKE_KEY in arg for command in result['commands'] for arg in command))

    def test_candidate_failure_does_not_stop_live_app(self):
        result=self.exercise('candidate')
        self.assertEqual(result['host'],ORIGINAL)
        self.assertIsNone(result['cron'])
        self.assertFalse(any(c[:2] == ('docker','stop') for c in result['commands']))

    def test_start_failure_restores_previous_container(self):
        result=self.exercise('start')
        self.assertEqual(result['name'],'/nms-app')
        self.assertIn(('docker','rename','old-id','nms-app'),result['commands'])
        self.assertEqual(result['host'],ORIGINAL)
        self.assertIsNone(result['cron'])

    def test_worker_failure_restores_disabled_mode_without_scheduler(self):
        result=self.exercise('worker')
        self.assertEqual(result['name'],'/nms-app')
        self.assertEqual(result['host'],ORIGINAL)
        self.assertIsNone(result['cron'])

    def test_inactive_cron_stops_before_switch(self):
        result=self.exercise(cron_active=False)
        self.assertFalse(any(c[:2] == ('docker','create') for c in result['commands']))
        self.assertEqual(result['host'],ORIGINAL)

    def test_existing_scheduler_is_preserved(self):
        result=self.exercise(existing_cron=True)
        self.assertEqual(result['cron'],'preserve existing scheduler\n')
        self.assertFalse(any(c[:2] == ('docker','create') for c in result['commands']))

    def test_already_enabled_sending_is_not_reconfigured(self):
        result=self.exercise(mode='send')
        self.assertEqual(result['host'],ORIGINAL)
        self.assertFalse(any(c[:2] == ('docker','create') for c in result['commands']))

    def test_worker_matches_embedded_copy(self):
        self.assertEqual((ROOT/'scripts/process-tour-emails.cjs').read_text(),activation.RUNNER)


if __name__ == '__main__': unittest.main()
