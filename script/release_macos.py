#!/usr/bin/env python3
"""Build an auditable private preview ZIP; publishing is a separate explicit step."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def run(args, **kwargs):
    subprocess.run(args, check=True, cwd=kwargs.pop('cwd', ROOT), **kwargs)


def capture(args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True, help='Preview tag, e.g. v0.6.2-preview.1')
    args = parser.parse_args()
    match = re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-preview\.([1-9][0-9]*)', args.tag)
    if not match:
        parser.error('Use vMAJOR.MINOR.PATCH-preview.N; this recipe only produces non-notarized previews.')
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        parser.error('Release packaging currently requires an Apple Silicon Mac.')
    if capture(['git', 'status', '--porcelain']):
        parser.error('Commit changes first so the release identifies exact source.')
    commit = capture(['git', 'rev-parse', 'HEAD'])
    version = '.'.join(match.groups()[:3])
    destination = ROOT / 'build' / 'releases' / args.tag
    if destination.exists():
        parser.error('Output already exists; use a new preview number. Existing release assets are immutable.')
    run(['npm', 'run', 'check'])
    run(['npm', 'test'])
    run(['./script/test_macos.sh'])
    run(['npm', 'run', 'build'])
    run([os.environ.get('WSB_BUILD_PYTHON', 'python3.12'), 'script/build_speech_runtime.py'])
    run(['swift', 'build', '--package-path', 'macos', '--configuration', 'release',
         '-Xswiftc', '-debug-prefix-map', '-Xswiftc', str(ROOT) + '=/Sidekick'])
    run(['python3', 'script/package_macos.py', '--release'])
    app = ROOT / 'build/release/Sidekick.app'
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info['CFBundleShortVersionString'] != version:
        raise RuntimeError('Tag version does not match the app version; no archive created.')
    run(['codesign', '--verify', '--deep', '--strict', str(app)])
    for path in app.rglob('*'):
        if path.is_symlink() and not path.resolve().is_relative_to(app.resolve()):
            raise RuntimeError('External symlink in release bundle')
        if path.name in {'admin-token', '.env', '.git', '.local'} or path.suffix in {'.sqlite', '.db', '.log'}:
            raise RuntimeError('Unexpected runtime/private file in release bundle: ' + str(path.relative_to(app)))
    if capture(['git', 'rev-parse', 'HEAD']) != commit or capture(['git', 'status', '--porcelain']):
        raise RuntimeError('Source changed during build; commit and rebuild before releasing.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Publish the directory only after both the archive and its extraction validate.
    with tempfile.TemporaryDirectory(prefix='sidekick-release-', dir=destination.parent) as temporary:
        stage = Path(temporary)
        archive = stage / ('Sidekick-' + args.tag[1:] + '-macOS-arm64.zip')
        run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive)])
        with tempfile.TemporaryDirectory(prefix='sidekick-extract-') as extraction:
            run(['ditto', '-x', '-k', str(archive), extraction])
            restored = Path(extraction) / 'Sidekick.app'
            run(['codesign', '--verify', '--deep', '--strict', str(restored)])
            executable = restored / 'Contents/MacOS/SessionBridge'
            if not os.access(executable, os.X_OK):
                raise RuntimeError('App executable lost its mode in ZIP')
            # Verify packaged Node without starting a service or connecting WhatsApp.
            run([str(restored / 'Contents/Resources/runtime/node'), '--version'])
        manifest = stage / 'release-manifest.json'
        manifest.write_text(json.dumps({
            'tag': args.tag, 'sourceCommit': commit,
            'appVersion': version, 'appBuild': info['CFBundleVersion'],
            'architecture': 'arm64', 'minimumMacOS': info['LSMinimumSystemVersion'],
            'configuration': 'release', 'signing': 'ad-hoc', 'notarized': False,
            'artifact': archive.name, 'sha256': digest(archive), 'bytes': archive.stat().st_size,
        }, indent=2) + '\n')
        (stage / 'SHA256SUMS.txt').write_text(''.join(digest(p) + '  ' + p.name + '\n' for p in [archive, manifest]))
        os.rename(stage, destination)
    print('Preview assets: ' + str(destination))
    print('Not notarized. Upload only as a clearly labelled private prerelease.')


if __name__ == '__main__':
    main()
