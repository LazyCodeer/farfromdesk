"""Reject incomplete or mismatched Intel app bundles before reusing a run cache."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys


def valid_app(app: Path, version: str, build: str) -> bool:
    executable = app / 'Contents/MacOS/FarFromDesk'
    try:
        with (app / 'Contents/Info.plist').open('rb') as source:
            info = plistlib.load(source)
        if (info.get('CFBundleShortVersionString') != version
                or str(info.get('CFBundleVersion')) != build
                or not executable.is_file() or not os.access(executable, os.X_OK)):
            return False
        result = subprocess.run(
            ['lipo', '-archs', str(executable)], capture_output=True,
            text=True, check=True, timeout=10,
        )
        return 'x86_64' in result.stdout.split()
    except (OSError, ValueError, plistlib.InvalidFileException, subprocess.SubprocessError):
        return False


if __name__ == '__main__':
    if len(sys.argv) != 4 or not valid_app(Path(sys.argv[1]), sys.argv[2], sys.argv[3]):
        print('Cached Intel app is missing, invalid, or has the wrong version or architecture.', file=sys.stderr)
        sys.exit(1)
