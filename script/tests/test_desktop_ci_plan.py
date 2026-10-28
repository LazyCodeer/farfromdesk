import sys
import tempfile
import subprocess
import os
import json
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desktop_ci_plan import plan, TARGETS, release_identity


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
            history=Path(tmp)/'releases.json';history.write_text('[]')
            subprocess.run([sys.executable, str(root/'script/desktop_ci_plan.py')], cwd=root,
                env={**os.environ, 'FFD_EVENT':'push','FFD_REF':'refs/heads/main',
                     'FFD_RUN':'1234','FFD_NUMBER':'99','FFD_RELEASE_HISTORY':str(history),'FFD_SHA':'a'*40,'GITHUB_OUTPUT':str(output)},check=True)
            values=dict(line.split('=',1) for line in output.read_text().splitlines())
            release=json.loads((root/'release.json').read_text())
            self.assertEqual(values['version'],release['version'])
            self.assertNotIn('preview', values['version'])
            self.assertGreaterEqual(int(values['build']),release['build'])


class AutomaticReleaseVersionTests(unittest.TestCase):
    def row(self, version, sha='b'*40, draft=False):
        return {'tag_name': 'v'+version, 'target_commitish': sha, 'draft': draft, 'prerelease': False}

    def test_new_app_push_increments_public_patch_without_manifest_edit(self):
        self.assertEqual(release_identity('0.7.1', [self.row('0.7.1')], 'a'*40), ('0.7.2', False))
        self.assertEqual(release_identity('0.8.0', [self.row('0.7.1')], 'a'*40), ('0.8.0', False))

    def test_matching_published_commit_skips_rebuilding_immutable_assets(self):
        self.assertEqual(release_identity('0.7.1', [self.row('0.7.2', 'a'*40)], 'a'*40), ('0.7.2', True))

    def test_failed_draft_resumes_exact_identity_and_other_drafts_are_reserved(self):
        self.assertEqual(release_identity('0.7.1', [self.row('0.7.2', 'a'*40, True)], 'a'*40), ('0.7.2', False))
        self.assertEqual(release_identity('0.7.1', [self.row('0.7.2', draft=True)], 'a'*40), ('0.7.3', False))

    def test_previews_and_source_only_tags_do_not_set_stable_version(self):
        rows=[self.row('0.7.1'), self.row('9.0.0-preview.1')]
        self.assertEqual(release_identity('0.7.1', rows, 'a'*40), ('0.7.2', False))

    def test_broken_history_and_invalid_versions_fail_closed(self):
        for args in [('bad', [], 'a'*40), ('0.7.1', {}, 'a'*40), ('0.7.1', [], 'main'), ('0.7.1', [None], 'a'*40)]:
            with self.assertRaises(ValueError): release_identity(*args)

    def test_workflows_have_one_push_check_path_and_never_publish_from_prs(self):
        root=Path(__file__).resolve().parents[2]
        workflow=(root/'.github/workflows/desktop.yml').read_text()
        checks=(root/'.github/workflows/desktop-checks.yml').read_text()
        self.assertIn("'src/**'", workflow)
        self.assertIn("'desktop/**'", workflow)
        self.assertIn('Read release history', workflow)
        self.assertIn('Require the current main commit', workflow)
        # Builds start alongside the checks, so publishing must still wait for them.
        self.assertIn('needs: [version, checks, desktop]', workflow)
        self.assertNotIn('  pull_request:', workflow)
        self.assertNotIn('  push:', checks)
        self.assertIn('  pull_request:', checks)
