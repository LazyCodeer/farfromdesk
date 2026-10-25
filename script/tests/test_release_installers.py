import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release_installers import write_installer


class InstallerEncodingTests(unittest.TestCase):
    def test_non_utf8_host_and_crlf_produce_canonical_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            target = Path(directory) / 'target'
            source.write_bytes('FarFromDesk … — 0.7.0-preview.1\r\n'.encode('utf-8'))
            code = ('from pathlib import Path; from release_installers import write_installer; '
                    'import sys; write_installer(Path(sys.argv[1]),Path(sys.argv[2]),"0.7.0-preview.42")')
            env = {**os.environ, 'PYTHONUTF8': '0', 'PYTHONCOERCECLOCALE': '0',
                   'LC_ALL': 'C', 'PYTHONPATH': str(Path(__file__).resolve().parents[1])}
            subprocess.run([sys.executable, '-X', 'utf8=0', '-c', code, str(source), str(target)],
                           env=env, check=True, capture_output=True)
            self.assertEqual(target.read_bytes(), 'FarFromDesk … — 0.7.0-preview.42\n'.encode('utf-8'))

    def test_invalid_utf8_does_not_replace_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source', Path(directory) / 'target'
            source.write_bytes(b'bad\xff')
            target.write_bytes(b'previous')
            with self.assertRaises(UnicodeDecodeError):
                write_installer(source, target, '0.7.0-preview.42')
            self.assertEqual(target.read_bytes(), b'previous')
