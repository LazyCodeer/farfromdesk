"""Build an Inno Setup installer from the same staged bundle as the portable ZIP."""
import os
from pathlib import Path
import re
import shutil
import subprocess


def build_windows_installer(app: Path, output: Path, version: str):
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?', version):
        raise ValueError('Invalid installer version')
    compiler = shutil.which('ISCC.exe') or str(Path(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)')) / 'Inno Setup 6' / 'ISCC.exe')
    if not Path(compiler).is_file():
        raise RuntimeError('Inno Setup 6 is required on the Windows build host')
    subprocess.run([compiler, '/Qp', '/DAppVersion=' + version,
                    '/DIconFile=' + str(Path(__file__).resolve().parents[1] / 'desktop/windows/runner/resources/app_icon.ico'),
                    '/DSourceDir=' + str(app.resolve()), '/DOutputDir=' + str(output.resolve()),
                    str(Path(__file__).with_suffix('.iss'))], check=True)
    installer = output / f'FarFromDesk-{version}-windows-x64-setup.exe'
    if not installer.is_file() or installer.stat().st_size == 0:
        raise RuntimeError('Windows installer was not produced')
    return installer
