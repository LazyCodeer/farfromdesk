"""Installer tests use fake downloads and an isolated home; no service is launched."""
import hashlib, io, os, pathlib, subprocess, tarfile, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parent.parent

@unittest.skipIf(os.name=='nt','POSIX shell installer; PowerShell is validated by Windows CI')
class InstallerTests(unittest.TestCase):
    def fixture(self, corrupt=False, traversal=False):
        temp=tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        root=pathlib.Path(temp.name); bin=root/'bin';bin.mkdir();home=root/'home with spaces';home.mkdir()
        archive=root/'download.tar.gz'
        with tarfile.open(archive,'w:gz') as tf:
            data=b'#!/bin/sh\nexit 0\n';entry=tarfile.TarInfo('../escaped' if traversal else 'FarFromDesk/farfromdesk');entry.mode=0o755;entry.size=len(data);tf.addfile(entry,io.BytesIO(data))
        checksum=root/'checksum';checksum.write_text(('0'*64 if corrupt else hashlib.sha256(archive.read_bytes()).hexdigest())+'  test.tar.gz\n')
        (bin/'uname').write_text('#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
        (bin/'curl').write_text('#!/bin/sh\nfor arg in "$@"; do case "$arg" in *.sha256) source="$FFD_TEST_CHECKSUM";; https://*.tar.gz) source="$FFD_TEST_ARCHIVE";; esac; done\nfor last do :; done\ncp "$source" "$last"\n')
        for p in bin.iterdir():p.chmod(0o755)
        env={**os.environ,'PATH':str(bin)+os.pathsep+os.environ['PATH'],'HOME':str(home),'FFD_TEST_ARCHIVE':str(archive),'FFD_TEST_CHECKSUM':str(checksum),'FFD_NO_LAUNCH':'1','FFD_VERSION':'0.0.0-fixture'}
        result=subprocess.run(['sh',str(ROOT/'install/install.sh')],env=env,text=True,capture_output=True)
        return result,home,root
    def test_verified_archive_installs_app_and_menu_with_spaces(self):
        result,home,_=self.fixture();self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue((home/'.local/opt/farfromdesk/0.0.0-fixture/farfromdesk').exists())
        entry=(home/'.local/share/applications/farfromdesk.desktop').read_text();self.assertIn('Name=FarFromDesk',entry);self.assertIn('Exec="',entry)
    def test_checksum_mismatch_leaves_installation_absent(self):
        result,home,_=self.fixture(corrupt=True);self.assertNotEqual(result.returncode,0);self.assertIn('Checksum mismatch',result.stderr);self.assertFalse((home/'.local/opt').exists())
    def test_traversal_is_rejected_even_with_matching_checksum(self):
        result,home,root=self.fixture(traversal=True);self.assertNotEqual(result.returncode,0);self.assertIn('Unsafe archive',result.stderr);self.assertFalse((root/'escaped').exists());self.assertFalse((home/'.local/opt').exists())

if __name__=='__main__':unittest.main()
