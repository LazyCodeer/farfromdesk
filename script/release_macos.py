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
    parser.add_argument('--arch', choices=['arm64', 'x86_64'], default='arm64')
    args = parser.parse_args()
    match = re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-preview\.([1-9][0-9]*)', args.tag)
    if not match:
        parser.error('Use vMAJOR.MINOR.PATCH-preview.N; this recipe only produces non-notarized previews.')
    if platform.system() != 'Darwin':
        parser.error('Release packaging requires macOS.')
    if capture(['git', 'status', '--porcelain']):
        parser.error('Commit changes first so the release identifies exact source.')
    commit = capture(['git', 'rev-parse', 'HEAD'])
    version = '.'.join(match.groups()[:3])
    destination = ROOT / 'build' / 'releases' / args.tag / args.arch
    if destination.exists():
        parser.error('Output already exists; use a new preview number. Existing release assets are immutable.')
    run(['npm', 'run', 'check'])
    run(['npm', 'test'])
    run(['./script/test_macos.sh'])
    run(['npm', 'run', 'build'])
    run([os.environ.get('WSB_BUILD_PYTHON', 'python3.12'), 'script/build_speech_runtime.py'], env={**os.environ, 'WSB_TARGET_ARCH': args.arch})
    run(['swift', 'build', '--package-path', 'macos', '--configuration', 'release',
         '--triple', args.arch + '-apple-macosx14.0', '--scratch-path', str(ROOT / 'build' / ('swift-release-' + args.arch)),
         '-debug-info-format', 'none'])
    run([os.environ.get('WSB_BUILD_PYTHON', 'python3.12'), 'script/package_macos.py', '--release', '--arch', args.arch])
    app = ROOT / 'build' / ('release-' + args.arch) / 'Sidekick.app'
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info['CFBundleShortVersionString'] != version:
        raise RuntimeError('Tag version does not match the app version; no archive created.')
    run(['codesign', '--verify', '--deep', '--strict', str(app)])
    binaries = [app / 'Contents/MacOS/SessionBridge', app / 'Contents/Resources/runtime/node',
                app / 'Contents/Resources/speech/ffmpeg', app / 'Contents/Resources/speech/whisper-cli']
    binaries.extend(app.rglob('*.node'))
    for binary in binaries:
        archs = capture(['lipo', '-archs', str(binary)]).split()
        if args.arch not in archs:
            raise RuntimeError('Wrong binary architecture: ' + str(binary.relative_to(app)))
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
        archive = stage / ('Sidekick-' + args.tag[1:] + '-macOS-' + args.arch + '.zip')
        run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive)])
        with tempfile.TemporaryDirectory(prefix='sidekick-extract-') as extraction:
            run(['ditto', '-x', '-k', str(archive), extraction])
            restored = Path(extraction) / 'Sidekick.app'
            run(['codesign', '--verify', '--deep', '--strict', str(restored)])
            executable = restored / 'Contents/MacOS/SessionBridge'
            if not os.access(executable, os.X_OK):
                raise RuntimeError('App executable lost its mode in ZIP')
            # Verify packaged Node without starting a service or connecting WhatsApp.
            node = restored / 'Contents/Resources/runtime/node'
            if capture([str(node), '-p', 'process.arch']) != ('arm64' if args.arch == 'arm64' else 'x64'):
                raise RuntimeError('Bundled Node architecture mismatch')
            smoke = "const root=process.argv[1]; const {Store}=await import(root+'/bridge/dist/store.js'); const {installBundledAudio}=await import(root+'/bridge/dist/speech-bundle.js'); const s=new Store(':memory:'); if(!installBundledAudio(s,root+'/speech').configured)throw new Error('Voice bundle not configured'); console.log('Bundled voice configuration verified');"
            run([str(node), '--input-type=module', '-e', smoke, str(restored / 'Contents/Resources')])
            speech = restored / 'Contents/Resources/speech'
            run(['./node_modules/.bin/tsx', '--test', 'test/media-local.test.ts'], env={**os.environ,
                'WSB_AUDIO_TEST_FFMPEG': str(speech / 'ffmpeg'),
                'WSB_AUDIO_TEST_WHISPER': str(speech / 'whisper-cli'),
                'WSB_AUDIO_TEST_MODEL': str(speech / 'ggml-base.bin')})
        # A read-only DMG gives users a visible .app and an Applications shortcut.
        dmg = stage / ('Sidekick-' + args.tag[1:] + '-macOS-' + args.arch + '.dmg')
        with tempfile.TemporaryDirectory(prefix='sidekick-dmg-') as source:
            run(['ditto', str(app), str(Path(source) / 'Sidekick.app')])
            (Path(source) / 'Applications').symlink_to('/Applications')
            run(['hdiutil', 'create', '-volname', 'Sidekick', '-srcfolder', source, '-format', 'UDZO', '-ov', str(dmg)])
        run(['hdiutil', 'verify', str(dmg)])
        manifest = stage / ('release-manifest-' + args.arch + '.json')
        manifest.write_text(json.dumps({
            'tag': args.tag, 'sourceCommit': commit,
            'appVersion': version, 'appBuild': info['CFBundleVersion'],
            'architecture': args.arch, 'buildHostArchitecture': platform.machine(), 'minimumMacOS': info['LSMinimumSystemVersion'],
            'configuration': 'release', 'signing': 'ad-hoc', 'notarized': False,
            'artifacts': [{'name': p.name, 'sha256': digest(p), 'bytes': p.stat().st_size} for p in [archive, dmg]],
            'intelHardwareTested': False,
        }, indent=2) + '\n')
        (stage / ('SHA256SUMS-' + args.arch + '.txt')).write_text(''.join(digest(p) + '  ' + p.name + '\n' for p in [archive, dmg, manifest]))
        os.rename(stage, destination)
    print('Preview assets: ' + str(destination))
    print('Not notarized. Upload only as a clearly labelled private prerelease.')


if __name__ == '__main__':
    main()
