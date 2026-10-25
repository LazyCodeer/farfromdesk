import sys
import tempfile
import subprocess
import os
import json
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desktop_ci_plan import plan, TARGETS


class DesktopBuildSelectionTests(unittest.TestCase):
    def test_default_manual_check_is_linux_only_and_never_publishes(self):
        result = plan('workflow_dispatch', 'refs/heads/main')
        self.assertEqual(result['matrix']['include'], [TARGETS['linux']])
        self.assertFalse(result['publish'])

    def test_each_target_can_be_checked_on_a_feature_branch(self):
        for target in TARGETS:
            with self.subTest(target=target):
                result = plan('workflow_dispatch', 'refs/heads/fix', target)
                self.assertEqual(result['matrix']['include'], [TARGETS[target]])
                self.assertFalse(result['publish'])

    def test_release_push_builds_all_platforms_and_publishes(self):
        result = plan('push', 'refs/heads/main')
        self.assertEqual(len(result['matrix']['include']), 4)
        self.assertTrue(result['publish'])

    def test_manual_publication_requires_all_targets_on_main(self):
        self.assertTrue(plan('workflow_dispatch', 'refs/heads/main', 'all', 'true')['publish'])
        for ref, target in [('refs/heads/fix', 'all'), ('refs/heads/main', 'linux')]:
            with self.assertRaises(ValueError):
                plan('workflow_dispatch', ref, target, 'true')

    def test_unsupported_triggers_and_inputs_fail_before_runner_allocation(self):
        for args in [('pull_request', 'refs/heads/main'), ('push', 'refs/heads/fix'),
                     ('workflow_dispatch', 'refs/heads/main', 'unknown'),
                     ('workflow_dispatch', 'refs/heads/main', 'all', 'yes')]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                plan(*args)

    def test_release_identity_is_stable_and_build_is_monotonic(self):
        root=Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'output'
            subprocess.run([sys.executable, str(root/'script/desktop_ci_plan.py')], cwd=root,
                env={**os.environ, 'FFD_EVENT':'push','FFD_REF':'refs/heads/main',
                     'FFD_RUN':'1234','FFD_NUMBER':'99','GITHUB_OUTPUT':str(output)},check=True)
            values=dict(line.split('=',1) for line in output.read_text().splitlines())
            release=json.loads((root/'release.json').read_text())
            self.assertEqual(values['version'],release['version'])
            self.assertNotIn('preview', values['version'])
            self.assertGreaterEqual(int(values['build']),release['build'])
