"""Publish only a complete, verified four-target private desktop preview."""
import argparse
import json
from pathlib import Path
import re
import tempfile
from publish_release import digest, gh, release_state

TARGETS = {'macos-15': ('macos', 'arm64'), 'macos-15-intel': ('macos', 'x64'),
           'ubuntu-22.04': ('linux', 'x64'), 'windows-2022': ('windows', 'x64')}


def validate(root, version, commit):
    if not re.fullmatch(r'\d+\.\d+\.\d+-preview\.[1-9]\d*', version):
        raise ValueError('Invalid preview version')
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
            raise ValueError('Preview signing metadata mismatch')
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
    def private():
        if json.loads(gh('repo', 'view', args.repo, '--json', 'visibility'))['visibility'] != 'PRIVATE':
            raise RuntimeError('This preview publisher requires a private repository')
    private()
    tag = 'v'+args.version
    state = release_state(args.repo, tag)
    if state and not state['isDraft']:
        ref = json.loads(gh('api', f'repos/{args.repo}/git/ref/tags/{tag}'))['object']
        if ref['type'] != 'commit' or ref['sha'] != args.commit or not state['isPrerelease']:
            raise RuntimeError('Existing release identity mismatch')
        verify_remote(state, files)
        print('Verified immutable release: '+state['url'])
        return
    if state and state['targetCommitish'] != args.commit:
        raise RuntimeError('Draft belongs to another source commit')
    if not state:
        notes = (f'# FarFromDesk shared desktop preview\n\nSource: `{args.commit}`.\n\n'
                 'One Flutter UI and Node backend for macOS Apple Silicon/Intel, Windows x64, and Linux x64 (glibc 2.35+). '
                 'ZIP/DMG files contain FarFromDesk.app on Mac; Windows ZIP and Linux tar.gz contain the installed desktop app. '
                 'Local voice tools and model are bundled. Checksums and manifests are included.\n\n'
                 '**Private preview: Mac ad-hoc signed and not notarized; Windows unsigned.** '
                 'Do not disable OS security protections. Linux requires GTK 3 and a desktop session. '
                 'Mac native Desktop integrations retain their existing Python/account requirements; '
                 'Windows/Linux support CLI sessions, not injection into Desktop chats. Native permissions remain in force.\n\n'
                 'All target builds, native startup smoke checks, local speech tests and configured test suites passed. '
                 'These isolated tests do not prove real-phone/provider account compatibility on every OS. '
                 'Installer scripts target these private assets; anonymous download access is not enabled.\n')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'notes.md'; path.write_text(notes)
            gh('release', 'create', tag, '--repo', args.repo, '--target', args.commit,
               '--draft', '--prerelease', '--title', 'FarFromDesk '+args.version, '--notes-file', str(path))
    gh('release', 'upload', tag, '--repo', args.repo, '--clobber', *map(str, files.values()))
    state = release_state(args.repo, tag)
    if not state or not state['isDraft']:
        raise RuntimeError('Draft changed during upload')
    verify_remote(state, files)
    private()
    gh('release', 'edit', tag, '--repo', args.repo, '--draft=false', '--prerelease')
    print('Published '+tag)


if __name__ == '__main__':
    main()
