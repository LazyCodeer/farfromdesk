#!/usr/bin/env python3
"""Build an isolated local permissions UI/helper; never install or run a bridge."""
import pathlib, plistlib, subprocess, hashlib
from prepare_desktop_driver import prepare
root = pathlib.Path(__file__).resolve().parents[1]
destination = root / 'build/owner-view-test/native'
app = destination / 'FarFromDesk Owner View Test.app'
identity = 'com.codecylabs.farfromdesk.ownerviewtest'
executable = app / 'Contents/MacOS/ffd-accessibility'
executable.parent.mkdir(parents=True, exist_ok=True)
source = (root / 'native/accessibility-helper.swift').read_text()
marker = 'if CommandLine.arguments.contains("--server") {'
assert source.count(marker) == 1
source = source.replace(marker, (root / 'native/owner-view/setup.swift').read_text() + '\nif !CommandLine.arguments.contains("--server") && !CommandLine.arguments.contains("--diagnostic") { openOwnerViewSetup() } else ' + marker)
generated = destination.parent / 'owner-view-helper.swift'
generated.write_text(source)
subprocess.run(['xcrun','swiftc','-O','-framework','AppKit','-framework','ApplicationServices','-framework','ScreenCaptureKit',str(generated),'-o',str(executable)], check=True)
(app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
 'CFBundleIdentifier':identity, 'CFBundleName':'FarFromDesk Owner View Test',
 'CFBundleDisplayName':'FarFromDesk Owner View Test','CFBundleExecutable':'ffd-accessibility',
 'CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'0.1',
 'NSAccessibilityUsageDescription':'Owner-operated local test of selected window controls.',
 'NSScreenCaptureUsageDescription':'Owner-operated local test of selected window screenshots.'
}))
subprocess.run(['codesign','--force','--sign','-','--identifier',identity,str(app)], check=True)
subprocess.run(['codesign','--verify','--strict',str(app)], check=True)
driver = destination / 'cua-driver/cua-driver'
if not driver.exists() or hashlib.sha256(driver.read_bytes()).hexdigest() != '92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f':
 prepare(destination / 'cua-driver')
else:
 subprocess.run(['codesign','--verify','--strict',str(driver)], check=True)
print(app)
