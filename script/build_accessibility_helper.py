#!/usr/bin/env python3
"""Build the optional local macOS AX helper without requiring full Xcode."""
import argparse, pathlib, plistlib, subprocess, sys

root = pathlib.Path(__file__).resolve().parent.parent
if sys.platform != 'darwin':
    raise SystemExit('Accessibility helper requires macOS')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('destination', nargs='?', type=pathlib.Path, default=root / 'build/desktop-backend/native')
parser.add_argument('--bundle-id', choices=['com.codecylabs.farfromdesk.accessibility', 'com.codecylabs.farfromdesk.localtest.accessibility'], default='com.codecylabs.farfromdesk.accessibility')
args = parser.parse_args()
destination = args.destination
app = destination / 'FarFromDesk Accessibility.app'
executable = app / 'Contents/MacOS/ffd-accessibility'
executable.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(['xcrun', 'swiftc', '-O', '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit', str(root / 'native/accessibility-helper.swift'), '-o', str(executable)], check=True)
(app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
    'CFBundleIdentifier': args.bundle_id,
    'CFBundleName': 'FarFromDesk Accessibility', 'CFBundleDisplayName': 'FarFromDesk Accessibility',
    'CFBundleExecutable': 'ffd-accessibility', 'CFBundlePackageType': 'APPL',
    'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'LSUIElement': True,
    'NSAccessibilityUsageDescription': 'Control only the apps and visible controls you select in FarFromDesk.',
}))
subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', args.bundle_id, str(app)], check=True)
print(app)
