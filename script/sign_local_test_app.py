#!/usr/bin/env python3
"""Sign a staged local test app with an existing Apple signing identity.

Does not create/import certificates, grant permissions, install or launch apps.
Never fall back to ad-hoc signing: its default requirement changes with each build.
"""
import argparse
from pathlib import Path
import plistlib
import re
import subprocess

APP_ID = 'com.codecylabs.farfromdesk.localtest'
HELPER_ID = APP_ID + '.accessibility'


def run(*args):
    result = subprocess.run(args, check=True, capture_output=True, text=True)
    return result.stdout + result.stderr


def preflight(app, identity):
    app = app.resolve()
    # Only operate on this project's staged bundles, never the running/installed app.
    staging = Path(__file__).resolve().parent.parent / '.local'
    if not app.is_relative_to(staging.resolve()):
        raise ValueError('Use a staged test bundle inside this project\'s .local directory.')
    if not re.fullmatch(r'[a-fA-F0-9]{40}', identity):
        raise ValueError('Choose the exact SHA-1 of an existing Apple code-signing identity.')
    identities = run('/usr/bin/security', 'find-identity', '-p', 'codesigning', '-v')
    found = re.findall(r'\b([A-Fa-f0-9]{40})\s+"([^"]+)"', identities)
    if not any(sha.lower() == identity.lower() and name.startswith(
        ('Apple Development:', 'Developer ID Application:', 'Mac Developer:')
    ) for sha, name in found):
        raise ValueError('No matching valid Apple development/application signing identity with a private key is available. No bundle changed.')
    helper = app / 'Contents/Resources/backend/native/FarFromDesk Accessibility.app'
    for bundle, expected in [(app, APP_ID), (helper, HELPER_ID)]:
        if not bundle.resolve().is_relative_to(app):
            raise ValueError('A signing target escapes the staged app. No bundle changed.')
        info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
        if info.get('CFBundleIdentifier') != expected:
            raise ValueError(f'Expected bundle identifier {expected}. No bundle changed.')
    runtime = app / 'Contents/Resources/backend/runtime/node'
    if not runtime.is_file() or not runtime.resolve().is_relative_to(app):
        raise ValueError('The staged backend runtime is missing. No bundle changed.')
    return [(helper, HELPER_ID), (runtime, APP_ID + '.backend'), (app, APP_ID)]


def verify_identity(component, expected):
    details = run('/usr/bin/codesign', '-d', '-r-', '--verbose=2', str(component))
    requirement = next((line for line in details.splitlines() if 'designated =>' in line), '')
    if not re.search(r'^Identifier=' + re.escape(expected) + r'$', details, re.MULTILINE):
        raise ValueError('Signed identifier does not match the intended local-test identifier.')
    if 'Signature=adhoc' in details or 'cdhash' in requirement or 'anchor apple' not in requirement:
        raise ValueError('The signature does not have the required Apple certificate-based identity.')
    team = re.search(r'^TeamIdentifier=([A-Za-z0-9]+)$', details, re.MULTILINE)
    if not team:
        raise ValueError('The signature has no Apple team identity.')
    return team.group(1), requirement


def sign(app, identity, check_only=False):
    components = preflight(app, identity)
    if check_only:
        return {'ready': True, 'signed': False}
    # Explicit inside-out signing. Preserve existing runtime entitlements, and let
    # codesign derive certificate-based requirements rather than preserving cdhashes.
    verified = []
    for component, identifier in components:
        run('/usr/bin/codesign', '--force', '--sign', identity, '--identifier', identifier,
            '--preserve-metadata=entitlements', str(component))
        verified.append(verify_identity(component, identifier))
    if len({team for team, _ in verified}) != 1:
        raise ValueError('Nested components were signed by different teams; do not launch this stage.')
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(app.resolve()))
    return {'ready': True, 'signed': True, 'requirements': [req for _, req in verified]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('--identity', required=True, help='Existing Apple signing certificate SHA-1')
    parser.add_argument('--check', action='store_true', help='Validate prerequisites without signing')
    args = parser.parse_args()
    try:
        print(sign(args.app, args.identity, args.check))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + '\n')
