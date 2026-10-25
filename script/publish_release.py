#!/usr/bin/env python3
"""Validate both Mac builds, then publish an immutable private GitHub prerelease."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

ARCHITECTURES = ('arm64', 'x86_64')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def validate_assets(root, tag, commit):
    if not re.fullmatch(r'v\d+\.\d+\.\d+-preview\.[1-9]\d*', tag):
        raise ValueError('Invalid preview tag')
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Expected an exact source commit')
    files = {}
    builds = set()
    for arch in ARCHITECTURES:
        folder = root / arch
        manifest = folder / f'release-manifest-{arch}.json'
        checksum = folder / f'SHA256SUMS-{arch}.txt'
        expected = {manifest.name, checksum.name,
                    f'FarFromDesk-{tag[1:]}-macOS-{arch}.zip',
                    f'FarFromDesk-{tag[1:]}-macOS-{arch}.dmg'}
        if folder.is_symlink() or not folder.is_dir() or {p.name for p in folder.iterdir()} != expected:
            raise ValueError('Incomplete or unexpected architecture assets: ' + arch)
        for name in expected:
            p = folder / name
            if p.is_symlink() or not p.is_file() or p.stat().st_size == 0:
                raise ValueError('Invalid release file: ' + name)
            files[name] = p
        data = json.loads(manifest.read_text())
        if (data['tag'], data['sourceCommit'], data['architecture']) != (tag, commit, arch):
            raise ValueError('Manifest identity mismatch')
        if data['notarized'] is not False or data['signing'] != 'ad-hoc':
            raise ValueError('This workflow only publishes clearly labelled ad-hoc previews')
        builds.add(str(data['appBuild']))
        artifacts = data['artifacts']
        if len(artifacts) != 2 or {a['name'] for a in artifacts} != expected - {manifest.name, checksum.name}:
            raise ValueError('Manifest artifact names mismatch')
        for item in artifacts:
            path = files[item['name']]
            if digest(path) != item['sha256'] or path.stat().st_size != item['bytes']:
                raise ValueError('Artifact checksum mismatch')
        expected_checksums = {p.name: digest(p) for p in [manifest, *[files[a['name']] for a in artifacts]]}
        entries = [line.split('  ', 1) for line in checksum.read_text().splitlines()]
        if len(entries) != 3 or {name: sha for sha, name in entries} != expected_checksums:
            raise ValueError('Checksum file mismatch')
    if len(builds) != 1:
        raise ValueError('Architecture app builds differ')
    return files


def gh(*args):
    result = subprocess.run(['gh', *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout


def release_state(repo, tag):
    result = subprocess.run(['gh', 'release', 'view', tag, '--repo', repo,
                             '--json', 'isDraft,isPrerelease,targetCommitish,assets,url'], capture_output=True, text=True)
    if result.returncode:
        if 'release not found' in result.stderr.lower():
            return None
        raise RuntimeError('Cannot inspect release: ' + result.stderr.strip())
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
        parser.error('Invalid repository')
    files = validate_assets(args.assets, args.tag, args.commit)
    if json.loads(gh('repo', 'view', args.repo, '--json', 'visibility'))['visibility'] != 'PRIVATE':
        raise RuntimeError('Private preview publishing is disabled for public repositories')
    existing = release_state(args.repo, args.tag)
    if existing and not existing['isDraft']:
        ref = json.loads(gh('api', f'repos/{args.repo}/git/ref/tags/{args.tag}'))['object']
        if ref['type'] != 'commit' or ref['sha'] != args.commit:
            raise RuntimeError('Published tag does not match the source commit')
        if {a['name'] for a in existing['assets']} != set(files) or not existing['isPrerelease']:
            raise RuntimeError('Published release is not the expected completed preview')
        print('Release already published; immutable assets left intact: ' + existing['url'])
        return
    if existing and existing['targetCommitish'] != args.commit:
        raise RuntimeError('Draft belongs to a different source commit')
    if not existing:
        notes = (f'# FarFromDesk automatic Mac preview\n\nBuilt from `{args.commit}`.\n\n'
                 'Choose **arm64** for Apple Silicon or **x86_64** for Intel. '
                 'The DMG and ZIP both contain FarFromDesk.app. Checksums and architecture manifests are included.\n\n'
                 '**Private, ad-hoc signed preview; not Apple-notarized.** macOS may block it. '
                 'Do not disable security protections. Requires macOS 14+, Python 3 and a compatible signed-in coding app.\n\n'
                 'Windows and Linux apps are in the pipeline. This release contains Mac builds only.\n\n'
                 'Build, signature, archive and synthetic voice checks passed. This does not establish '
                 'real-phone or full UI compatibility for every provider/account. See manifests for build-host architecture.\n')
        with tempfile.TemporaryDirectory(prefix='ffd-release-notes-') as directory:
            path = Path(directory) / 'notes.md'
            path.write_text(notes)
            gh('release', 'create', args.tag, '--repo', args.repo, '--target', args.commit, '--draft', '--prerelease',
               '--title', 'FarFromDesk ' + args.tag[1:], '--notes-file', str(path))
    gh('release', 'upload', args.tag, '--repo', args.repo, '--clobber', *[str(p) for p in files.values()])
    uploaded = release_state(args.repo, args.tag)
    if not uploaded or not uploaded['isDraft']:
        raise RuntimeError('Release changed during upload')
    remote = {a['name']: a for a in uploaded['assets']}
    if set(remote) != set(files):
        raise RuntimeError('Unexpected uploaded assets')
    for name, path in files.items():
        item = remote[name]
        if item['state'] != 'uploaded' or item['size'] != path.stat().st_size or item.get('digest') != 'sha256:' + digest(path):
            raise RuntimeError('GitHub asset verification failed: ' + name)
    # Recheck visibility immediately before publication; never change it here.
    if json.loads(gh('repo', 'view', args.repo, '--json', 'visibility'))['visibility'] != 'PRIVATE':
        raise RuntimeError('Repository visibility changed during upload')
    print(gh('release', 'edit', args.tag, '--repo', args.repo, '--draft=false', '--prerelease').strip())


if __name__ == '__main__':
    main()
