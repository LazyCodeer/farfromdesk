import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('signing', Path(__file__).resolve().parents[1] / 'script/sign_local_test_app.py')
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class SigningTests(unittest.TestCase):
    def test_rejects_installed_app_before_running_any_command(self):
        with patch.object(signing, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'staged'):
                signing.preflight(Path('/Applications/FarFromDesk.app'), 'a' * 40)
            run.assert_not_called()

    def test_missing_certificate_does_not_sign(self):
        app = Path(__file__).resolve().parents[1] / '.local/signing-test/Test.app'
        with patch.object(signing, 'run', return_value='0 valid identities found') as run:
            with self.assertRaisesRegex(ValueError, 'No matching valid Apple'):
                signing.sign(app, 'a' * 40)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0], '/usr/bin/security')

    def test_ad_hoc_identity_is_rejected(self):
        with patch.object(signing, 'run', return_value='Identifier=x\nSignature=adhoc\n# designated => cdhash H"abc"\n'):
            with self.assertRaisesRegex(ValueError, 'certificate-based'):
                signing.verify_identity(Path('/test'), 'x')

    def test_identifier_mismatch_is_rejected(self):
        with patch.object(signing, 'run', return_value='Identifier=wrong\n'):
            with self.assertRaisesRegex(ValueError, 'identifier'):
                signing.verify_identity(Path('/test'), 'expected')

    def test_certificate_requirement_is_accepted(self):
        data = 'Identifier=test.app\nTeamIdentifier=ABCD123456\n# designated => identifier "test.app" and anchor apple generic\n'
        with patch.object(signing, 'run', return_value=data):
            self.assertEqual(signing.verify_identity(Path('/test'), 'test.app')[0], 'ABCD123456')

    def test_check_only_has_no_signing_side_effect(self):
        with patch.object(signing, 'preflight', return_value=[]), patch.object(signing, 'run') as run:
            self.assertFalse(signing.sign(Path('/test'), 'a' * 40, check_only=True)['signed'])
            run.assert_not_called()

    def test_inside_out_signing_and_explicit_identifiers(self):
        components = [(Path('/helper'), 'test.helper'), (Path('/node'), 'test.backend'), (Path('/app'), 'test.app')]
        with patch.object(signing, 'preflight', return_value=components), patch.object(signing, 'run') as run, patch.object(signing, 'verify_identity', return_value=('TEAM', 'certificate requirement')):
            self.assertTrue(signing.sign(Path('/app'), 'a' * 40)['signed'])
            calls = [c.args for c in run.call_args_list]
            self.assertEqual([c[-1] for c in calls[:3]], ['/helper', '/node', '/app'])
            self.assertTrue(all('--identifier' in c for c in calls[:3]))
            self.assertIn('--verify', calls[-1])


if __name__ == '__main__':
    unittest.main()
