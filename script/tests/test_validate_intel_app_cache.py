from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from validate_intel_app_cache import valid_app


class IntelAppCacheTests(unittest.TestCase):
    def test_reuse_requires_the_requested_version_build_and_intel_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / 'FarFromDesk.app'
            executable = app / 'Contents/MacOS/FarFromDesk'
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b'fixture')
            executable.chmod(0o755)
            with (app / 'Contents/Info.plist').open('wb') as output:
                plistlib.dump({'CFBundleShortVersionString': '0.9.6', 'CFBundleVersion': '2310'}, output)
            with patch('validate_intel_app_cache.subprocess.run') as lipo:
                lipo.return_value = subprocess.CompletedProcess([], 0, stdout='x86_64\n')
                self.assertTrue(valid_app(app, '0.9.6', '2310'))
                self.assertFalse(valid_app(app, '0.9.7', '2310'))
                self.assertFalse(valid_app(app, '0.9.6', '2311'))
                lipo.return_value.stdout = 'arm64\n'
                self.assertFalse(valid_app(app, '0.9.6', '2310'))
                executable.unlink()
                self.assertFalse(valid_app(app, '0.9.6', '2310'))

    def test_missing_or_corrupt_plist_falls_back_to_building(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / 'FarFromDesk.app'
            self.assertFalse(valid_app(app, '0.9.6', '2310'))
            contents = app / 'Contents'
            contents.mkdir(parents=True)
            (contents / 'Info.plist').write_bytes(b'not a plist')
            self.assertFalse(valid_app(app, '0.9.6', '2310'))
