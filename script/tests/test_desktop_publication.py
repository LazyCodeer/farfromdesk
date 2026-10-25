import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish_desktop_release import TARGETS, validate, verify_remote, verify_tag
from publish_release import digest

VERSION='0.7.1'
COMMIT='b'*40

class DesktopPublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
        for runner,(system,arch) in TARGETS.items():
            folder=self.root/('farfromdesk-'+runner); folder.mkdir()
            artifacts=[]
            names=[f'FarFromDesk-{VERSION}-{system}-{arch}.{ext}' for ext in (['zip','dmg'] if system=='macos' else ['tar.gz' if system=='linux' else 'zip'])]
            if system=='windows':names.append(f'FarFromDesk-{VERSION}-windows-x64-setup.exe')
            for name in names:
                p=folder/name
                p.write_bytes(b'Archive-validation fixture')
                sha=digest(p);p.with_name(p.name+'.sha256').write_text(f'{sha}  {p.name}\n')
                artifacts.append({'name':p.name,'sha256':sha,'bytes':p.stat().st_size})
            (folder/f'manifest-{system}-{arch}.json').write_text(json.dumps({'schema':1,'version':VERSION,'sourceCommit':COMMIT,'platform':system,'architecture':arch,'nativeEntry':'main.dart','speechBundled':True,'voiceModelDelivery':'first-use','signing':'ad-hoc' if system=='macos' else 'unsigned','notarized':False,'artifacts':artifacts}))
            (folder/'install').mkdir()
            for name in ['install.sh','install.ps1']:(folder/'install'/name).write_text('Fixture '+VERSION)
    def tearDown(self):self.tmp.cleanup()
    def test_complete_all_platform_release(self):self.assertEqual(len(validate(self.root,VERSION,COMMIT)),20)
    def test_windows_exe_is_required(self):
        next(self.root.rglob('*-setup.exe')).unlink()
        with self.assertRaisesRegex(ValueError,'Unexpected target files'):validate(self.root,VERSION,COMMIT)
    def test_windows_exe_checksum_is_verified(self):
        next(self.root.rglob('*-setup.exe')).write_bytes(b'corrupt installer')
        with self.assertRaisesRegex(ValueError,'integrity'):validate(self.root,VERSION,COMMIT)
    def test_unstable_or_path_like_version_is_rejected(self):
        for version in ['0.7.1-preview.1', '../0.7.1', '01.7.1', 'v0.7.1']:
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, 'stable version'):
                validate(self.root, version, COMMIT)
    def test_tag_must_point_to_exact_source(self):
        with patch('publish_desktop_release.gh', return_value='[]'):
            verify_tag('owner/repo', 'v0.7.1', COMMIT)
            with self.assertRaises(RuntimeError): verify_tag('owner/repo', 'v0.7.1', COMMIT, required=True)
        ref={'ref':'refs/tags/v0.7.1','object':{'type':'commit','sha':COMMIT}}
        with patch('publish_desktop_release.gh', return_value=json.dumps([ref])):
            verify_tag('owner/repo', 'v0.7.1', COMMIT, required=True)
            with self.assertRaises(RuntimeError): verify_tag('owner/repo', 'v0.7.1', 'c'*40)
    def test_missing_platform(self):
        (self.root/'farfromdesk-windows-2022').rename(self.root/'unexpected')
        with self.assertRaisesRegex(ValueError,'four target'):validate(self.root,VERSION,COMMIT)
    def test_corruption(self):
        next(self.root.rglob('*.zip')).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'integrity'):validate(self.root,VERSION,COMMIT)
    def test_wrong_commit_and_preview_entry(self):
        p=next(self.root.rglob('manifest-*.json')); original=json.loads(p.read_text())
        for field,value in [('sourceCommit','c'*40),('nativeEntry','preview.dart'),('speechBundled',False),('notarized',True)]:
            p.write_text(json.dumps({**original,field:value}))
            with self.assertRaises(ValueError):validate(self.root,VERSION,COMMIT)
    def test_installer_targets_must_agree(self):
        next(self.root.rglob('install.sh')).write_text('Different installer '+VERSION)
        with self.assertRaisesRegex(ValueError,'disagree'):validate(self.root,VERSION,COMMIT)
    def test_remote_digest_required(self):
        files=validate(self.root,VERSION,COMMIT)
        assets=[{'name':n,'state':'uploaded','size':p.stat().st_size,'digest':'sha256:'+digest(p)} for n,p in files.items()]
        verify_remote({'assets':assets},files)
        assets[0]['digest']='sha256:'+'0'*64
        with self.assertRaisesRegex(RuntimeError,'integrity'):verify_remote({'assets':assets},files)

if __name__=='__main__':unittest.main()
