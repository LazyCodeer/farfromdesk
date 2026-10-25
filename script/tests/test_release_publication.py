import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish_release import digest, validate_assets

TAG = 'v0.6.2-preview.123'
COMMIT = 'a' * 40


class ReleaseValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for arch in ('arm64', 'x86_64'):
            folder = self.root / arch
            folder.mkdir()
            artifacts = []
            for ext in ('zip', 'dmg'):
                path = folder / f'FarFromDesk-{TAG[1:]}-macOS-{arch}.{ext}'
                path.write_bytes(b'Synthetic packaging validation fixture')
                artifacts.append({'name': path.name, 'sha256': digest(path), 'bytes': path.stat().st_size})
            manifest = folder / f'release-manifest-{arch}.json'
            manifest.write_text(json.dumps({'tag': TAG, 'sourceCommit': COMMIT, 'architecture': arch,
                'appBuild': '1001', 'signing': 'ad-hoc', 'notarized': False, 'artifacts': artifacts}))
            self.checksums(arch)

    def tearDown(self):
        self.temp.cleanup()

    def checksums(self, arch):
        folder = self.root / arch
        paths = sorted(p for p in folder.iterdir() if p.name != f'SHA256SUMS-{arch}.txt')
        (folder / f'SHA256SUMS-{arch}.txt').write_text(''.join(digest(p) + '  ' + p.name + '\n' for p in paths))

    def test_complete_matching_builds_pass(self):
        self.assertEqual(len(validate_assets(self.root, TAG, COMMIT)), 8)

    def test_corrupt_archive_is_rejected(self):
        next((self.root / 'arm64').glob('*.zip')).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            validate_assets(self.root, TAG, COMMIT)

    def test_missing_architecture_is_rejected(self):
        for p in (self.root / 'x86_64').iterdir():
            p.unlink()
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            validate_assets(self.root, TAG, COMMIT)

    def test_extra_file_is_rejected(self):
        (self.root / 'arm64' / 'admin-token').write_text('fixture')
        with self.assertRaisesRegex(ValueError, 'unexpected'):
            validate_assets(self.root, TAG, COMMIT)

    def test_wrong_commit_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'identity'):
            validate_assets(self.root, TAG, 'b' * 40)

    def test_different_build_numbers_are_rejected(self):
        p = self.root / 'x86_64' / 'release-manifest-x86_64.json'
        d = json.loads(p.read_text()); d['appBuild'] = '1002'; p.write_text(json.dumps(d))
        self.checksums('x86_64')
        with self.assertRaisesRegex(ValueError, 'builds differ'):
            validate_assets(self.root, TAG, COMMIT)

    def test_symlink_is_rejected(self):
        p = next((self.root / 'arm64').glob('*.zip'))
        copy = self.root / 'outside.zip'; copy.write_bytes(p.read_bytes()); p.unlink(); p.symlink_to(copy)
        with self.assertRaisesRegex(ValueError, 'Invalid release file'):
            validate_assets(self.root, TAG, COMMIT)

    def test_bad_checksum_list_is_rejected(self):
        (self.root / 'arm64' / 'SHA256SUMS-arm64.txt').write_text('0' * 64 + '  elsewhere\n')
        with self.assertRaisesRegex(ValueError, 'Checksum file'):
            validate_assets(self.root, TAG, COMMIT)

    def test_path_like_tag_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Invalid preview tag'):
            validate_assets(self.root, '../bad', COMMIT)

    def test_misleading_signing_state_is_rejected(self):
        p = self.root / 'arm64' / 'release-manifest-arm64.json'
        d = json.loads(p.read_text()); d['notarized'] = True; p.write_text(json.dumps(d))
        self.checksums('arm64')
        with self.assertRaisesRegex(ValueError, 'ad-hoc previews'):
            validate_assets(self.root, TAG, COMMIT)


if __name__ == '__main__':
    unittest.main()
