#!/usr/bin/env python3
"""Prepare a new source snapshot using tracked files plus explicit untracked files.

This does not grant filesystem access, run project code, install dependencies,
create a Codex session, or modify the source repository.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def declared_assets(manifest):
    """Read common Flutter asset/font declarations; reject unsupported syntax."""
    flutter = False
    assets_indent = None
    for raw in manifest.read_text().splitlines():
        line = raw.split(' #', 1)[0].rstrip()
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            flutter = line == 'flutter:'
            assets_indent = None
            continue
        if not flutter:
            continue
        text = line.strip()
        if re.match(r'(assets|fonts):\s*\S', text):
            raise ValueError(f'Inline asset/font declarations in {manifest.name} need review before copying')
        if assets_indent is not None and indent <= assets_indent:
            assets_indent = None
        if text == 'assets:':
            assets_indent = indent
            continue
        value = None
        if text.startswith('- asset:'):
            value = text[len('- asset:'):].strip()
        elif assets_indent is not None and text.startswith('- '):
            value = text[2:].strip()
            if value.startswith('path:'):
                value = value[5:].strip()
        if value is not None:
            if value[:1] in ('"', "'") and value[-1:] == value[:1]:
                value = value[1:-1]
            if not value or re.search(r'[{}\[\]*&!#]', value) or ':' in value:
                raise ValueError(f'Unsupported asset declaration in {manifest.name}; review it before copying')
            yield value


def plan(source, destination, include=()):
    source = source.resolve(strict=True)
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError('Destination must be a new directory; existing worker edits are never overwritten')
    if not destination.parent.is_dir():
        raise ValueError('Destination parent must already exist in the approved workspace')
    if source == destination.parent.resolve() or source in destination.parent.resolve().parents:
        raise ValueError('Destination must be outside the source repository')
    root = Path(git(source, 'rev-parse', '--show-toplevel').decode().strip()).resolve()
    if root != source:
        raise ValueError('Source must be the exact repository root')
    tracked = {x.decode() for x in git(source, 'ls-files', '-z', '--cached').split(b'\0') if x}
    untracked = {x.decode() for x in git(source, 'ls-files', '-z', '--others', '--exclude-standard').split(b'\0') if x}
    if set(include) - (tracked | untracked):
        raise ValueError('Extra files must be explicit repository-relative, nonignored Git paths')
    selected = tracked | set(include)
    files = []
    for name in sorted(selected):
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or '.git' in relative.parts:
            raise ValueError('Unsafe repository path')
        file = source / relative
        if file.is_symlink() or any(parent.is_symlink() for parent in file.parents if parent != source and source in parent.parents):
            raise ValueError(f'Symlink needs an explicit workspace decision: {name}')
        if not file.exists():
            continue  # Preserve working-tree deletions.
        if not file.is_file():
            raise ValueError(f'Submodule or non-file needs separate setup: {name}')
        files.append(name)
    selected = set(files)
    missing = []
    for name in files:
        if Path(name).name != 'pubspec.yaml':
            continue
        parent = Path(name).parent
        for asset in declared_assets(source / name):
            path = parent / asset
            if Path(asset).is_absolute() or '..' in Path(asset).parts:
                raise ValueError('Flutter assets must stay inside their package')
            key = path.as_posix()
            present = any(f.startswith(key.rstrip('/') + '/') for f in selected) if asset.endswith('/') else key in selected
            if not present:
                missing.append(key)
    if missing:
        raise ValueError('Required Flutter assets are absent from the snapshot: ' + ', '.join(sorted(set(missing))) + '. Add intended nonignored files with --include; do not request broader permissions to repair an incomplete copy.')
    return source, destination, files


def prepare(source, destination, include=(), check=False):
    source, destination, files = plan(source, destination, include)
    if not check:
        destination.mkdir()  # Exclusive creation; never overlay an existing worker.
        try:
            for name in files:
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source / name, target, follow_symlinks=False)
        except BaseException:
            shutil.rmtree(destination)
            raise
    return {'checked': True, 'copied': not check, 'files': len(files), 'destination': str(destination), 'untrackedIncluded': list(include), 'dependenciesInstalled': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--include', action='append', default=[], help='Explicit nonignored repository-relative file')
    parser.add_argument('--check', action='store_true', help='Validate without creating or copying')
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.source, args.destination, args.include, args.check)))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Workspace preparation stopped: {error}\n')
