import importlib.util
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('intel_smoke_observer', ROOT / 'script/intel_smoke_observer.py')
observer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(observer)


class IntelSmokeObserverTests(unittest.TestCase):
    def test_only_valid_numeric_process_metadata_is_kept(self):
        secret = 'credential' + '-never-log-this-value'
        rows = observer.parse_processes(' 10 1 10 S 1.2\n 11 10 11 R+ 2.5\n'
                                       ' 12 10 12 S 0.0 ' + secret + '\n'
                                       ' 13 1 13 S 3.0\n')
        data = observer.tree(10, rows)
        self.assertEqual([row['pid'] for row in data], [10, 11])
        self.assertNotIn(secret, json.dumps(data))
        self.assertEqual(observer.tree(99999, rows), [])

    def test_descendants_are_capped_and_cycles_do_not_loop(self):
        rows = {i: {'pid': i, 'parent': 2 if i == 1 else 1,
                    'group': i, 'state': 'S', 'cpu': 0.0}
                for i in range(1, 150)}
        self.assertEqual(len(observer.tree(1, rows)), observer.MAX_PROCESSES)

    def test_heartbeat_requires_the_known_supervisor_pid(self):
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = pathlib.Path(directory) / 'heartbeat'
            heartbeat.write_text('123 10000\n')
            self.assertEqual(observer.heartbeat_age(heartbeat, 123, 12), 2000)
            self.assertIsNone(observer.heartbeat_age(heartbeat, 124, 12))
            heartbeat.write_text('123 secret=do-not-print')
            self.assertIsNone(observer.heartbeat_age(heartbeat, 123, 12))

    @unittest.skipUnless(os.name == 'posix', 'Process sampling requires POSIX ps')
    def test_observer_terminates_when_process_exits_and_omits_argv_env(self):
        secret = 'sensitive' + '-synthetic-value'
        env = dict(os.environ, FFD_OBSERVER_TEST_SECRET=secret)
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(.8)', secret], env=env)
        reaper = threading.Thread(target=child.wait, daemon=True)
        reaper.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                heartbeat = pathlib.Path(directory) / 'heartbeat'
                result = subprocess.run([sys.executable, str(ROOT / 'script/intel_smoke_observer.py'),
                                         '--root-pid', str(child.pid), '--heartbeat', str(heartbeat),
                                         '--interval', '.2', '--max-samples', '12'],
                                        capture_output=True, text=True, timeout=5, check=True)
                data = [json.loads(line) for line in result.stdout.splitlines()]
                self.assertLessEqual(len(data), 12)
                self.assertNotIn(secret, result.stdout + result.stderr)
                self.assertTrue(any(row['root_present'] for row in data))
                self.assertIs(data[-1]['root_present'], False)
        finally:
            reaper.join(timeout=2)

    @unittest.skipUnless(os.name == 'posix' and shutil.which('node'),
                         'POSIX and Node.js are required')
    def test_running_and_blocked_event_loop_produce_distinct_heartbeat_age(self):
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, FFD_DIAGNOSTIC_DIR=directory, FFD_DIAGNOSTIC_HEARTBEAT_MS='100')
            script = "setTimeout(()=>{const end=Date.now()+1800;while(Date.now()<end){}},500);setTimeout(()=>{},2400)"
            node = subprocess.Popen(['node', '--import', str(ROOT / 'script/intel_diagnostic_heartbeat.mjs'),
                                     '-e', script], env=env)
            try:
                heartbeat = pathlib.Path(directory) / 'supervisor-heartbeat'
                deadline = time.monotonic() + 1.5
                while not heartbeat.exists() and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertTrue(heartbeat.exists())
                time.sleep(1.2)
                age = observer.heartbeat_age(heartbeat, node.pid, time.time())
                self.assertIsNotNone(age)
                self.assertGreater(age, 500)
            finally:
                node.kill()
                node.wait(timeout=2)

    @unittest.skipUnless(os.name == 'posix' and shutil.which('node'),
                         'POSIX and Node.js are required')
    def test_wrapper_preserves_failure_and_cleans_helpers(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = pathlib.Path(directory) / 'synthetic.mjs'
            fake.write_text('await new Promise(r=>setTimeout(r,700));process.exitCode=7;')
            result = subprocess.run(['bash', 'script/run_intel_diagnostic.sh', str(fake)], cwd=ROOT,
                                    env=dict(os.environ, RUNNER_TEMP=directory),
                                    capture_output=True, text=True, timeout=8)
            self.assertEqual(result.returncode, 7)
            match = re.search(r'Diagnostic helper PIDs: (\d+) (\d+)', result.stdout)
            self.assertIsNotNone(match)
            for pid in map(int, match.groups()):
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            self.assertFalse(list(pathlib.Path(directory).glob('ffd-diagnostic.*')))

    @unittest.skipUnless(os.name == 'posix' and shutil.which('node'),
                         'POSIX and Node.js are required')
    def test_wrapper_cancellation_stops_its_supervisor_and_helpers(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = pathlib.Path(directory) / 'synthetic.mjs'
            pidfile = pathlib.Path(directory) / 'synthetic-pid'
            fake.write_text("import {writeFileSync} from 'node:fs';writeFileSync(process.env.FFD_TEST_PID_PATH,String(process.pid));setInterval(()=>{},1000);")
            wrapper = subprocess.Popen(['bash', 'script/run_intel_diagnostic.sh', str(fake)], cwd=ROOT,
                                       env=dict(os.environ, RUNNER_TEMP=directory, FFD_TEST_PID_PATH=str(pidfile)),
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + 5
                while not pidfile.exists() and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertTrue(pidfile.exists())
                smoke_pid = int(pidfile.read_text())
                wrapper.send_signal(signal.SIGTERM)
                stdout, _ = wrapper.communicate(timeout=5)
                self.assertEqual(wrapper.returncode, 143)
                match = re.search(r'Diagnostic helper PIDs: (\d+) (\d+)', stdout)
                self.assertIsNotNone(match)
                for pid in [smoke_pid, *map(int, match.groups())]:
                    with self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
                self.assertFalse(list(pathlib.Path(directory).glob('ffd-diagnostic.*')))
            finally:
                if wrapper.poll() is None:
                    wrapper.kill()
                    wrapper.wait(timeout=2)


if __name__ == '__main__':
    unittest.main()
