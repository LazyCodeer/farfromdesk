import hashlib, pathlib, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
import sign_macos_bundle as signing

class DesktopSigningTests(unittest.TestCase):
    def test_vendor_code_is_verified_but_never_resigned(self):
        with tempfile.TemporaryDirectory() as temp:
            app=pathlib.Path(temp)/'FarFromDesk.app'
            vendor=app/'Contents/Resources/backend/native/cua-driver/cua-driver'
            vendor.parent.mkdir(parents=True);vendor.write_bytes(b'\xcf\xfa\xed\xfevendor')
            own=app/'Contents/MacOS/FarFromDesk';own.parent.mkdir();own.write_bytes(b'\xcf\xfa\xed\xfehost')
            with patch.object(signing,'CUA_SHA',hashlib.sha256(vendor.read_bytes()).hexdigest()),patch.object(signing.subprocess,'run') as run:
                signing.sign_bundle(app)
                commands=[c.args[0] for c in run.call_args_list]
                self.assertFalse(any('--sign' in c and c[-1]==str(vendor) for c in commands))
                self.assertTrue(any('--sign' in c and c[-1]==str(own) for c in commands))
                self.assertTrue(any('--verify' in c and c[-1]==str(vendor) for c in commands))
                self.assertTrue(any('--deep' in c and '--verify' in c for c in commands))
    def test_wrong_vendor_hash_stops_before_signing(self):
        with tempfile.TemporaryDirectory() as temp:
            app=pathlib.Path(temp)/'FarFromDesk.app';vendor=app/'Contents/Resources/backend/native/cua-driver/cua-driver'
            vendor.parent.mkdir(parents=True);vendor.write_bytes(b'changed')
            with patch.object(signing.subprocess,'run') as run:
                with self.assertRaisesRegex(ValueError,'hash mismatch'):signing.sign_bundle(app)
                run.assert_not_called()
