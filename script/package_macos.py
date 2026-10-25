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
parser.add_argument('--release', action='store_true', help='Optimized Sidekick preview with production dependencies')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
configuration = 'release' if args.release else 'debug'
speech = root / 'build/speech-runtime'
if not (speech / 'manifest.json').is_file():
    raise RuntimeError('Build the speech runtime first: python3.12 script/build_speech_runtime.py')
import json
speech_manifest = json.loads((speech / 'manifest.json').read_text())
for name in ('ffmpeg', 'whisper-cli', 'ggml-base.bin'):
    if hashlib.sha256((speech / name).read_bytes()).hexdigest() != speech_manifest['sha256'][name]:
        raise RuntimeError('Bundled speech asset checksum mismatch: ' + name)
output = root / "build" / "release" / "Sidekick.app" if args.release else root / "build" / "Session Bridge.app"
if output.exists():
    shutil.rmtree(output)
contents = output / "Contents"
macos = contents / "MacOS"
resources = contents / "Resources"
macos.mkdir(parents=True)
(resources / "runtime").mkdir(parents=True)
shutil.copytree(speech, resources / 'speech')
bin_path = subprocess.check_output(["swift", "build", "--package-path", str(root / "macos"), "--configuration", configuration, "--show-bin-path"], text=True).strip()
shutil.copy2(Path(bin_path) / "SessionBridge", macos / "SessionBridge")
# SwiftPM resource bundle contains only the licensed UI fonts.
shutil.copytree(Path(bin_path) / "SessionBridge_SessionBridge.bundle", resources / "SessionBridge_SessionBridge.bundle")
node = Path(subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip())
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
        subprocess.run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'], cwd=temporary, check=True)
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
    "CFBundleName": "Sidekick", "CFBundleDisplayName": "Sidekick",
    "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "0.6.2", "CFBundleVersion": "40",
    "CFBundleIconFile": "SessionBridge",
    "LSMinimumSystemVersion": "14.0", "NSPrincipalClass": "NSApplication",
    "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    "NSHumanReadableCopyright": "Sidekick contributors — MIT License",
}
with (contents / "Info.plist").open("wb") as stream:
    plistlib.dump(plist, stream)
# Ad-hoc signing is for local use only, not a Developer ID or notarization claim.
subprocess.run(["codesign", "--force", "--sign", "-", str(resources / "runtime" / "node")], check=True)
subprocess.run(["codesign", "--force", "--sign", "-", str(output)], check=True)
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(output)], check=True)
print(output)
