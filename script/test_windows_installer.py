"""CI smoke test for install, reinstall and uninstall, without launching the app."""
import argparse
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--version', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
setup = root / f'build/desktop-release/FarFromDesk-{args.version}-windows-x64-setup.exe'
with tempfile.TemporaryDirectory(prefix='ffd-installer-') as temp:
    target = Path(temp) / 'Installed app'
    preserved = Path(temp) / 'account-data'
    preserved.write_text('preserve pairing and history')
    try:
        for _ in range(2):
            subprocess.run([str(setup), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
                            '/DIR=' + str(target), '/LOG=' + str(Path(temp) / 'setup.log')],
                           check=True, timeout=180)
            for name in ['farfromdesk.exe', 'backend/runtime/node.exe', 'backend/dist/main.js',
                         'speech/ffmpeg.exe', 'speech/whisper-cli.exe', 'speech/manifest.json']:
                assert (target / name).is_file(), name
            assert not (target / 'speech/ggml-base.bin').exists(), 'Model belongs in first-use cache'
    finally:
        uninstaller = target / 'unins000.exe'
        if uninstaller.exists():
            subprocess.run([str(uninstaller), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
                           check=True, timeout=120)
            deadline = time.monotonic() + 15
            while (target / 'farfromdesk.exe').exists() and time.monotonic() < deadline:
                time.sleep(.2)
            assert not (target / 'farfromdesk.exe').exists()
    assert preserved.read_text() == 'preserve pairing and history'
print('Windows EXE install, reinstall and uninstall passed.')
