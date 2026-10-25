"""Publish only a complete, verified four-target public desktop release."""
import argparse
import json
from pathlib import Path
import re
import tempfile
from publish_release import digest, gh, release_state

TARGETS = {'macos-15': ('macos', 'arm64'), 'macos-15-intel': ('macos', 'x64'),
           'ubuntu-22.04': ('linux', 'x64'), 'windows-2022': ('windows', 'x64')}


def validate(root, version, commit):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
        raise ValueError('Invalid stable version')
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Exact source commit required')
    if {p.name for p in root.iterdir()} != {'farfromdesk-'+r for r in TARGETS}:
        raise ValueError('All four target builds are required')
    files = {}
    for runner, (system, arch) in TARGETS.items():
        folder = root / ('farfromdesk-'+runner)
        manifest = folder / f'manifest-{system}-{arch}.json'
        extensions = ['zip', 'dmg'] if system == 'macos' else ['tar.gz' if system == 'linux' else 'zip']
        names = {f'FarFromDesk-{version}-{system}-{arch}.{ext}' for ext in extensions}
        expected = names | {n+'.sha256' for n in names} | {manifest.name, 'install'}
        if folder.is_symlink() or {p.name for p in folder.iterdir()} != expected:
            raise ValueError('Unexpected target files: '+runner)
        for p in folder.rglob('*'):
            if p.is_symlink() or (p.is_file() and not p.stat().st_size):
                raise ValueError('Unsafe or empty release file')
        data = json.loads(manifest.read_text())
        if (data['schema'], data['version'], data['sourceCommit'], data['platform'], data['architecture']) != (1, version, commit, system, arch):
            raise ValueError('Manifest identity mismatch')
        if data['nativeEntry'] != 'main.dart' or data['speechBundled'] is not True:
            raise ValueError('Native app and bundled speech required')
        if data['notarized'] is not False or data['signing'] != ('ad-hoc' if system == 'macos' else 'unsigned'):
            raise ValueError('Signing metadata mismatch')
        if len(data['artifacts']) != len(names) or {a['name'] for a in data['artifacts']} != names:
            raise ValueError('Unexpected manifest assets')
        for item in data['artifacts']:
            p = folder / item['name']
            sha = digest(p)
            if sha != item['sha256'] or p.stat().st_size != item['bytes']:
                raise ValueError('Asset integrity mismatch')
            checksum = folder / (p.name+'.sha256')
            if checksum.read_text().strip() != f'{sha}  {p.name}':
                raise ValueError('Checksum file mismatch')
            files[p.name] = p
            files[checksum.name] = checksum
        files[manifest.name] = manifest
        install = folder / 'install'
        if {p.name for p in install.iterdir()} != {'install.sh', 'install.ps1'}:
            raise ValueError('Unexpected installer files')
        for p in install.iterdir():
            if version not in p.read_text():
                raise ValueError('Installer version mismatch')
            if p.name in files and p.read_bytes() != files[p.name].read_bytes():
                raise ValueError('Target installers disagree')
            files[p.name] = p
    return files


def verify_remote(release, files):
    assets = {a['name']: a for a in release['assets']}
    if set(assets) != set(files):
        raise RuntimeError('Remote release assets differ')
    for name, path in files.items():
        a = assets[name]
        if a['state'] != 'uploaded' or a['size'] != path.stat().st_size or a.get('digest') != 'sha256:'+digest(path):
            raise RuntimeError('Remote release integrity check failed: '+name)


def verify_tag(repo, tag, commit, required=False):
    refs = json.loads(gh('api', f'repos/{repo}/git/matching-refs/tags/{tag}'))
    exact = [r for r in refs if r['ref'] == 'refs/tags/' + tag]
    if not exact and not required:
        return
    if len(exact) != 1 or exact[0]['object']['type'] != 'commit' or exact[0]['object']['sha'] != commit:
        raise RuntimeError('Release tag source commit mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', required=True, type=Path)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', args.repo):
        parser.error('Invalid repository')
    files = validate(args.assets, args.version, args.commit)
    def public():
        if json.loads(gh('repo', 'view', args.repo, '--json', 'visibility'))['visibility'] != 'PUBLIC':
            raise RuntimeError('Stable releases require a public repository')
    public()
    tag = 'v'+args.version
    state = release_state(args.repo, tag)
    verify_tag(args.repo, tag, args.commit)
    if state and not state['isDraft']:
        ref = json.loads(gh('api', f'repos/{args.repo}/git/ref/tags/{tag}'))['object']
        if ref['type'] != 'commit' or ref['sha'] != args.commit or state['isPrerelease']:
            raise RuntimeError('Existing release identity mismatch')
        verify_remote(state, files)
        print('Verified immutable release: '+state['url'])
        return
    if state and state['targetCommitish'] != args.commit:
        raise RuntimeError('Draft belongs to another source commit')
    if not state:
        notes = (f'# FarFromDesk {args.version}\n\n'
                 'Your coding sessions, one WhatsApp message away.\n\n'
                 '## Choose your download\n\n'
                 '| Computer | Asset |\n|---|---|\n'
                 f'| Apple Silicon Mac (macOS 14+) | `FarFromDesk-{args.version}-macos-arm64.dmg` or `.zip` |\n'
                 f'| Intel Mac (macOS 14+) | `FarFromDesk-{args.version}-macos-x64.dmg` or `.zip` |\n'
                 f'| Windows 10/11 x64 | `FarFromDesk-{args.version}-windows-x64.zip` |\n'
                 f'| Linux x64, glibc 2.35+, GTK 3 | `FarFromDesk-{args.version}-linux-x64.tar.gz` |\n\n'
                 'Mac DMG/ZIP contains **FarFromDesk.app**. Extract Windows/Linux archives before opening. '
                 'The automatically generated Source code archives are for contributors, not app installation.\n\n'
                 '## Get started\n\n'
                 '1. Install and open FarFromDesk on your computer.\n'
                 '2. Link WhatsApp using the QR code in the app.\n'
                 '3. Choose your coding platform and coordinator session, then message yourself.\n\n'
                 'Local voice tools and the multilingual model are included. '
                 'Codex/Claude accounts are separate and must have access to the selected runtime. '
                 'Mac supports native Desktop integrations (Python 3 required) and CLI sessions; '
                 'Windows/Linux support CLI sessions. Native permissions still apply.\n\n'
                 '## Updating\n\n'
                 'On macOS, choose Update and restart to download, verify and install future updates in the app. '
                 'Older builds need one manual update to acquire automatic installation. Windows/Linux keep '
                 'the manual download flow. Requests and pairing are stored outside the app bundle. '
                 'The version-pinned install.sh/install.ps1 assets install into your user account.\n\n'
                 '**Signing:** Mac builds are ad-hoc signed, not Apple-notarized; Windows builds are unsigned. '
                 'Your OS may require explicit approval or block installation under organizational policy. '
                 'Do not disable OS protections.\n\n'
                 '## Verification\n\n'
                 'All four builds must pass configured checks before publication. SHA-256 files and '
                 'platform manifests accompany every app archive. These build and isolated startup/speech '
                 'checks do not establish real-phone/provider-account compatibility on every computer.\n\n'
                 f'Source commit: `{args.commit}`. License: MIT.\n')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'notes.md'; path.write_text(notes)
            gh('release', 'create', tag, '--repo', args.repo, '--target', args.commit,
               '--draft', '--title', 'FarFromDesk '+args.version, '--notes-file', str(path))
    gh('release', 'upload', tag, '--repo', args.repo, '--clobber', *map(str, files.values()))
    state = release_state(args.repo, tag)
    if not state or not state['isDraft']:
        raise RuntimeError('Draft changed during upload')
    verify_remote(state, files)
    public()
    gh('release', 'edit', tag, '--repo', args.repo, '--draft=false', '--prerelease=false', '--latest')
    published = release_state(args.repo, tag)
    if not published or published['isDraft'] or published['isPrerelease']:
        raise RuntimeError('Stable publication was not confirmed')
    verify_remote(published, files)
    verify_tag(args.repo, tag, args.commit, required=True)
    print('Published '+tag)


if __name__ == '__main__':
    main()
