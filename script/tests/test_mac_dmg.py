import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mac_dmg import create_dmg


BUSY = 'hdiutil: create failed - Resource busy\n'


class MacDmgTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dmg = self.root / 'FarFromDesk-test.dmg'
        self.unrelated = self.root / 'unrelated.dmg'
        self.unrelated.write_text('keep')
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict('os.environ', {'GITHUB_ACTIONS': ''})
        env.start()
        self.addCleanup(env.stop)

    def fake_run(self, outcomes):
        outcomes = iter(outcomes)
        def run(command, **kwargs):
            self.assertEqual(command[-1], str(self.dmg))
            self.assertEqual(command[:2], ['hdiutil', 'create'])
            self.assertFalse(self.dmg.exists(), 'partial output leaked into a new attempt')
            self.assertEqual(kwargs, {'capture_output': True, 'text': True, 'timeout': 120})
            code, stderr = next(outcomes)
            if code is None:
                self.dmg.write_text('partial')
                raise subprocess.TimeoutExpired(command, 120)
            self.dmg.write_text('valid' if code == 0 else 'partial')
            return subprocess.CompletedProcess(command, code, stdout='', stderr=stderr)
        return run

    def test_busy_then_success_removes_partial_and_retries(self):
        self.dmg.write_text('old')
        with patch('mac_dmg.subprocess.run', side_effect=self.fake_run([(1, BUSY), (0, '')])) as run, \
             patch('mac_dmg.time.sleep') as sleep, patch('sys.stderr', new_callable=io.StringIO):
            create_dmg(self.root, self.dmg)
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(3)
        self.assertEqual(self.dmg.read_text(), 'valid')
        self.assertEqual(self.unrelated.read_text(), 'keep')

    def test_busy_exhaustion_fails_and_removes_partial(self):
        with patch('mac_dmg.subprocess.run', side_effect=self.fake_run([(1, BUSY)] * 3)) as run, \
             patch('mac_dmg.time.sleep') as sleep, patch('sys.stderr', new_callable=io.StringIO) as stderr:
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                create_dmg(self.root, self.dmg)
        self.assertEqual(run.call_count, 3)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [3, 6])
        self.assertEqual(raised.exception.stderr, BUSY)
        self.assertIn(BUSY, stderr.getvalue())
        self.assertFalse(self.dmg.exists())
        self.assertEqual(self.unrelated.read_text(), 'keep')

    def test_other_error_does_not_retry_or_keep_partial(self):
        problem = 'hdiutil: create failed - Permission denied\n'
        with patch('mac_dmg.subprocess.run', side_effect=self.fake_run([(2, problem)])) as run, \
             patch('mac_dmg.time.sleep') as sleep, patch('sys.stderr', new_callable=io.StringIO) as stderr:
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                create_dmg(self.root, self.dmg)
        run.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(raised.exception.stderr, problem)
        self.assertIn(problem, stderr.getvalue())
        self.assertFalse(self.dmg.exists())

    def test_unrelated_busy_text_does_not_retry(self):
        problem = 'Resource busy while logging\nhdiutil: create failed - Permission denied\n'
        with patch('mac_dmg.subprocess.run', side_effect=self.fake_run([(1, problem)])) as run, \
             patch('mac_dmg.time.sleep') as sleep, patch('sys.stderr', new_callable=io.StringIO):
            with self.assertRaises(subprocess.CalledProcessError):
                create_dmg(self.root, self.dmg)
        run.assert_called_once()
        sleep.assert_not_called()
        self.assertFalse(self.dmg.exists())

    def test_hung_create_is_killed_and_retried(self):
        with patch('mac_dmg.subprocess.run', side_effect=self.fake_run([(None, ''), (0, '')])) as run, \
             patch('mac_dmg.time.sleep') as sleep, patch('sys.stderr', new_callable=io.StringIO):
            create_dmg(self.root, self.dmg)
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(3)
        self.assertEqual(self.dmg.read_text(), 'valid')
        first, second = (c.args[0] for c in run.call_args_list)
        self.assertIn('HFS+', first)
        self.assertNotIn('HFS+', second)
        self.assertIn('UDZO', second)

    def test_repeated_hang_fails_without_partial(self):
        with patch('mac_dmg.subprocess.run', side_effect=self.fake_run([(None, '')] * 3)) as run, \
             patch('mac_dmg.time.sleep'), patch('sys.stderr', new_callable=io.StringIO):
            with self.assertRaises(subprocess.TimeoutExpired):
                create_dmg(self.root, self.dmg)
        self.assertEqual(run.call_count, 3)
        self.assertFalse(self.dmg.exists())


    def test_ci_hang_kills_orphaned_helper_before_retry(self):
        calls = []
        create = self.fake_run([(None, ''), (0, '')])
        def run(command, **kwargs):
            calls.append(command[0])
            return subprocess.CompletedProcess(command, 0) if command[0] == 'pkill' else create(command, **kwargs)
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'true'}), patch('mac_dmg.subprocess.run', side_effect=run), \
             patch('mac_dmg.time.sleep'), patch('sys.stderr', new_callable=io.StringIO):
            create_dmg(self.root, self.dmg)
        self.assertEqual(calls, ['hdiutil', 'pkill', 'hdiutil'])

    def test_success_without_image_fails(self):
        def run(command, **kwargs):
            return subprocess.CompletedProcess(command, 0, stdout='', stderr='')
        with patch('mac_dmg.subprocess.run', side_effect=run), patch('sys.stderr', new_callable=io.StringIO):
            with self.assertRaises(subprocess.CalledProcessError):
                create_dmg(self.root, self.dmg)


if __name__ == '__main__':
    unittest.main()
