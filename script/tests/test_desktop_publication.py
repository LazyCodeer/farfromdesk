import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish_desktop_release import TARGETS, validate, verify_remote
from publish_release import digest

VERSION='0.7.0-preview.123'
COMMIT='b'*40

class DesktopPublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
        for runner,(system,arch) in TARGETS.items():
            folder=self.root/('farfromdesk-'+runner); folder.mkdir()
            artifacts=[]
            for ext in (['zip','dmg'] if system=='macos' else ['tar.gz' if system=='linux' else 'zip']):
                p=folder/f'FarFromDesk-{VERSION}-{system}-{arch}.{ext}'
                p.write_bytes(b'Archive-validation fixture')
                sha=digest(p);p.with_name(p.name+'.sha256').write_text(f'{sha}  {p.name}\n')
                artifacts.append({'name':p.name,'sha256':sha,'bytes':p.stat().st_size})
            (folder/f'manifest-{system}-{arch}.json').write_text(json.dumps({'schema':1,'version':VERSION,'sourceCommit':COMMIT,'platform':system,'architecture':arch,'nativeEntry':'main.dart','speechBundled':True,'signing':'ad-hoc' if system=='macos' else 'unsigned','notarized':False,'artifacts':artifacts}))
            (folder/'install').mkdir()
            for name in ['install.sh','install.ps1']:(folder/'install'/name).write_text('Fixture '+VERSION)
    def tearDown(self):self.tmp.cleanup()
    def test_complete_all_platform_release(self):self.assertEqual(len(validate(self.root,VERSION,COMMIT)),18)
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
