#!/usr/bin/env python3
"""Stage an explicit allowlist; never include user state, tokens, or .local files."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import hashlib
import argparse
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--build-number', type=int)
parser.add_argument('--arch', choices=['arm64', 'x86_64'], default='arm64')
parser.add_argument('--release', action='store_true', help='Optimized FarFromDesk preview with production dependencies')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
configuration = 'release' if args.release else 'debug'
import json
release_metadata = json.loads((root / 'release.json').read_text())
build_number = args.build_number if args.build_number is not None else release_metadata['build']
if not 1 <= build_number <= 2147483647:
    raise RuntimeError('Invalid app build number')
speech = root / ('build/speech-runtime' if args.arch == 'arm64' else 'build/speech-runtime-x86_64')
if not (speech / 'manifest.json').is_file():
    raise RuntimeError('Build the speech runtime first: python3.12 script/build_speech_runtime.py')
import json
speech_manifest = json.loads((speech / 'manifest.json').read_text())
if speech_manifest['architecture'] != ('arm64' if args.arch == 'arm64' else 'x64'):
    raise RuntimeError('Speech architecture does not match target')
for name in ('ffmpeg', 'whisper-cli', 'ggml-base.bin'):
    if hashlib.sha256((speech / name).read_bytes()).hexdigest() != speech_manifest['sha256'][name]:
        raise RuntimeError('Bundled speech asset checksum mismatch: ' + name)
output = root / "build" / ("release-" + args.arch) / "FarFromDesk.app" if args.release else root / "build" / "Session Bridge.app"
if output.exists():
    shutil.rmtree(output)
contents = output / "Contents"
macos = contents / "MacOS"
resources = contents / "Resources"
macos.mkdir(parents=True)
(resources / "runtime").mkdir(parents=True)
shutil.copytree(speech, resources / 'speech')
swift_args = ["swift", "build", "--package-path", str(root / "macos"), "--configuration", configuration]
if args.release:
    swift_args += ['--triple', args.arch + '-apple-macosx14.0', '--scratch-path', str(root / 'build' / ('swift-release-' + args.arch))]
bin_path = subprocess.check_output(swift_args + ['--show-bin-path'], text=True).strip()
shutil.copy2(Path(bin_path) / "SessionBridge", macos / "SessionBridge")
# SwiftPM resource bundle contains only the licensed UI fonts.
shutil.copytree(Path(bin_path) / "SessionBridge_SessionBridge.bundle", resources / "SessionBridge_SessionBridge.bundle")
node = Path(subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip())
if args.release:
    # Official target-architecture Node archive; verify bytes against its versioned SHA-256 list.
    import tarfile
    import urllib.request
    version = subprocess.check_output(['node', '-p', 'process.version'], text=True).strip()
    cpu = 'arm64' if args.arch == 'arm64' else 'x64'
    archive_name = 'node-' + version + '-darwin-' + cpu + '.tar.gz'
    node_cache = root / 'build' / 'release-node'
    node_cache.mkdir(parents=True, exist_ok=True)
    base = 'https://nodejs.org/dist/' + version + '/'
    with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60) as response:
        entries = response.read().decode().splitlines()
    checksum = next(line.split()[0] for line in entries if line.split()[-1] == archive_name)
    archive = node_cache / archive_name
    if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        with urllib.request.urlopen(base + archive_name, timeout=60) as source, archive.open('wb') as target:
            shutil.copyfileobj(source, target)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        raise RuntimeError('Node archive checksum mismatch')
    extracted = node_cache / archive_name.removesuffix('.tar.gz')
    if extracted.exists():
        shutil.rmtree(extracted)
    with tarfile.open(archive) as source:
        source.extractall(node_cache, filter='data')
    node = extracted / 'bin/node'
shutil.copy2(node, resources / "runtime" / "node")
node_license = node.parent.parent / "LICENSE"
if args.release and not node_license.is_file():
    raise RuntimeError("Node LICENSE is required for a release bundle")
if node_license.exists():
    shutil.copy2(node_license, resources / "runtime" / "NODE-LICENSE")
shutil.copy2(root / "macos" / "SessionBridge.icns", resources / "SessionBridge.icns")
bridge = resources / "bridge"
bridge.mkdir()
for directory in (("dist", "skills") if args.release else ("dist", "skills", "node_modules")):
    shutil.copytree(root / directory, bridge / directory, symlinks=True,
                    ignore=shutil.ignore_patterns(".cache", ".DS_Store"))
if args.release:
    # Isolated install: never prune or mutate the working development dependencies.
    with tempfile.TemporaryDirectory(prefix='sidekick-production-') as temporary:
        for name in ('package.json', 'package-lock.json'):
            shutil.copy2(root / name, Path(temporary) / name)
        subprocess.run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund', '--os=darwin', '--cpu=' + ('arm64' if args.arch == 'arm64' else 'x64')], cwd=temporary, check=True)
        shutil.copytree(Path(temporary) / 'node_modules', bridge / 'node_modules', symlinks=True)
for name in ("package.json", "package-lock.json", "MASTER.md", "LICENSE", "THIRD_PARTY_NOTICES.md"):
    shutil.copy2(root / name, bridge / name)
# Native transport is vendored deliberately; no private config is copied.
shutil.copytree(root / "native", bridge / "native", ignore=shutil.ignore_patterns("__pycache__"))
for path in bridge.rglob("*"):
    if path.is_symlink() and not path.resolve().is_relative_to(bridge.resolve()):
        raise RuntimeError(f"Refusing external symlink in bundle: {path.relative_to(bridge)}")
plist = {
    "CFBundleExecutable": "SessionBridge", "CFBundleIdentifier": "app.sessionbridge.mac",
    "CFBundleName": "FarFromDesk", "CFBundleDisplayName": "FarFromDesk",
    "CFBundlePackageType": "APPL", "CFBundleShortVersionString": release_metadata["version"], "CFBundleVersion": str(build_number),
    "CFBundleIconFile": "SessionBridge",
    "LSMinimumSystemVersion": "14.0", "NSPrincipalClass": "NSApplication",
    "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    "NSHumanReadableCopyright": "FarFromDesk contributors — MIT License",
}
with (contents / "Info.plist").open("wb") as stream:
    plistlib.dump(plist, stream)
# Ad-hoc signing is for local use only, not a Developer ID or notarization claim.
subprocess.run(["codesign", "--force", "--sign", "-", str(resources / "runtime" / "node")], check=True)
subprocess.run(["codesign", "--force", "--sign", "-", str(output)], check=True)
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(output)], check=True)
print(output)
