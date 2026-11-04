#!/usr/bin/env python3
"""Build the optional local macOS AX helper without requiring full Xcode.

Both helpers this produces are TCC subjects. macOS stores the Accessibility and
Screen Recording grants against the code requirement it saw, and for an ad-hoc
signature that requirement is a bare `cdhash H"..."`. Recompiling an unchanged
helper therefore produces different bytes, which macOS reads as a different app,
and the owner silently loses both grants (and with them phone remote control).

Compiling is deterministic for a given source plus toolchain: building the current
source reproduces the installed helper's cdhash exactly, and the result does not
depend on the output directory. So each helper is cached under build/ on a key of
its source bytes, the toolchain version and the exact compile arguments, and reused
when nothing that can change the bytes has changed. A rebuild then keeps the same
bytes, and the grant survives. It is also faster.

`--no-cache` forces a clean compile, for a release that must build from source.
"""
import argparse, hashlib, pathlib, plistlib, shutil, subprocess, sys

root = pathlib.Path(__file__).resolve().parent.parent
if sys.platform != 'darwin':
    raise SystemExit('Accessibility helper requires macOS')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('destination', nargs='?', type=pathlib.Path, default=root / 'build/desktop-backend/native')
parser.add_argument('--bundle-id', choices=['com.codecylabs.farfromdesk.accessibility', 'com.codecylabs.farfromdesk.localtest.accessibility'], default='com.codecylabs.farfromdesk.accessibility')
parser.add_argument('--session-identifier', default=None, help='Code signing identifier for session-state; derived from --bundle-id by default.')
parser.add_argument('--no-cache', action='store_true', help='Always compile and re-sign, never reuse a cached helper.')
args = parser.parse_args()
destination = args.destination
cache = root / 'build/native-helper-cache'
session_identifier = args.session_identifier or args.bundle_id.replace('.accessibility', '.session-state')

AX_FLAGS = ['-O', '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit']
SESSION_FLAGS = ['-O', '-framework', 'CoreGraphics', '-framework', 'Security']
ax_source = root / 'native/accessibility-helper.swift'
session_source = root / 'native/owner-view/session-state.swift'


def capture(argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True).stdout.strip()


def toolchain():
    """Everything outside the source that can change the emitted bytes."""
    return '\n'.join([
        capture(['xcrun', 'swiftc', '--version']),
        'sdk ' + capture(['xcrun', '--show-sdk-version']),
        'sdk-path ' + capture(['xcrun', '--show-sdk-path']),
    ])


def key(*parts):
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part if isinstance(part, bytes) else str(part).encode())
        digest.update(b'\0')
    return digest.hexdigest()[:32]


def verify(artifact):
    return subprocess.run(['codesign', '--verify', '--strict', str(artifact)], capture_output=True).returncode == 0


def replace(src, dest, is_dir):
    if dest.exists():
        shutil.rmtree(dest) if is_dir else dest.unlink()
    (shutil.copytree if is_dir else shutil.copy2)(src, dest, symlinks=True) if is_dir else shutil.copy2(src, dest)


def reuse_or_build(cache_path, dest, build, is_dir, label):
    """Reuse the cached artifact when it is intact, otherwise build it and cache it."""
    if cache_path.exists() and not args.no_cache:
        if verify(cache_path):
            replace(cache_path, dest, is_dir)
            print(f'{label}: reused (source and toolchain unchanged) - the macOS grant stays valid', file=sys.stderr)
            return
        print(f'{label}: discarding a cache entry that no longer verifies', file=sys.stderr)
        shutil.rmtree(cache_path) if is_dir else cache_path.unlink()
    build()
    print(f'{label}: compiled - macOS sees a new app, so Accessibility and Screen Recording must be allowed again', file=sys.stderr)
    if not args.no_cache:
        cache.mkdir(parents=True, exist_ok=True)
        replace(dest, cache_path, is_dir)


def codesign_field(path, field):
    info = subprocess.run(['codesign', '-d', '-vvv', str(path)], capture_output=True, text=True)
    for line in (info.stderr or info.stdout).splitlines():
        if line.startswith(field + '='):
            return line.split('=', 1)[1]
    return 'unknown'


# ---------------------------------------------------------------- Accessibility helper
app = destination / 'FarFromDesk Accessibility.app'
executable = app / 'Contents/MacOS/ffd-accessibility'
plist = plistlib.dumps({
    'CFBundleIdentifier': args.bundle_id,
    'CFBundleName': 'FarFromDesk Accessibility', 'CFBundleDisplayName': 'FarFromDesk Accessibility',
    'CFBundleExecutable': 'ffd-accessibility', 'CFBundlePackageType': 'APPL',
    'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'LSUIElement': True,
    'NSAccessibilityUsageDescription': 'Control only the apps and visible controls you select in FarFromDesk.',
})
ax_key = key('accessibility', toolchain(), ' '.join(AX_FLAGS), ax_source.read_bytes(), plist, args.bundle_id)


def build_accessibility():
    executable.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['xcrun', 'swiftc', *AX_FLAGS, str(ax_source), '-o', str(executable)], check=True)
    (app / 'Contents/Info.plist').write_bytes(plist)
    subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', args.bundle_id, str(app)], check=True)


reuse_or_build(cache / f'accessibility-{ax_key}.app', app, build_accessibility, True, 'Accessibility helper')

# ---------------------------------------------------------------- owner-view session-state
# Given an explicit identifier on purpose: without one the linker derives it from the
# binary's UUID, so it moves with every build and the TCC entry cannot be named or
# reset with tccutil.
session_state = destination / 'session-state'
session_key = key('session-state', toolchain(), ' '.join(SESSION_FLAGS), session_source.read_bytes(), session_identifier)


def build_session_state():
    session_state.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['xcrun', 'swiftc', *SESSION_FLAGS, str(session_source), '-o', str(session_state)], check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', session_identifier, str(session_state)], check=True)


reuse_or_build(cache / f'session-state-{session_key}', session_state, build_session_state, False, 'session-state helper')

# Say what macOS will see, so a build log answers "which grant is this?" without a dig.
for path in (app, session_state):
    if not verify(path):
        raise SystemExit(f'Signed helper does not verify: {path}')
    print(f'{path}\n  identifier {codesign_field(path, "Identifier")}\n  cdhash     {codesign_field(path, "CDHash")}')