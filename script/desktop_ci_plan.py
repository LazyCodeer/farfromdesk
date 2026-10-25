"""Select native jobs and an immutable version before allocating build runners."""
import json
import os
from pathlib import Path
import re

TARGETS = {
    'linux': {'runner': 'ubuntu-22.04', 'target': 'linux', 'arch': 'x86_64'},
    'windows': {'runner': 'windows-2022', 'target': 'windows', 'arch': 'x86_64'},
    'macos-arm64': {'runner': 'macos-15', 'target': 'macos', 'arch': 'arm64'},
    'macos-x64': {'runner': 'macos-15-intel', 'target': 'macos', 'arch': 'x86_64'},
}


def plan(event, ref, target='', publish='false'):
    if event == 'push' and ref == 'refs/heads/main':
        # App/build changes on main publish only after all native checks pass.
        target, publish = 'all', 'true'
    elif event != 'workflow_dispatch':
        raise ValueError('Native builds require a release push or manual dispatch')
    target = target or 'linux'
    if target not in {*TARGETS, 'all'} or publish not in ('true', 'false', ''):
        raise ValueError('Invalid build selection')
    should_publish = publish == 'true'
    if should_publish and (target != 'all' or ref != 'refs/heads/main'):
        raise ValueError('Publication requires all targets on main')
    selected = list(TARGETS.values()) if target == 'all' else [TARGETS[target]]
    return {'matrix': {'include': selected}, 'publish': should_publish}


def release_identity(minimum, releases, commit):
    """Reserve the next stable patch, or resume this exact commit's draft."""
    stable = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
    if not stable.fullmatch(minimum) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Stable version and exact source commit required')
    if not isinstance(releases, list):
        raise ValueError('Release history must be a list')
    candidates = []
    for release in releases:
        if not isinstance(release, dict):
            raise ValueError('Invalid release history entry')
        tag = release.get('tag_name', '')
        version = tag.removeprefix('v')
        if not stable.fullmatch(version) or release.get('prerelease') is not False:
            continue
        if not isinstance(release.get('draft'), bool):
            raise ValueError('Release draft status is missing')
        candidates.append((tuple(map(int, version.split('.'))), release))
    matching = [(v, r) for v, r in candidates if r.get('target_commitish') == commit]
    if matching:
        number, release = max(matching, key=lambda item: item[0])
        return '.'.join(map(str, number)), not release['draft']
    floor = tuple(map(int, minimum.split('.')))
    if not candidates:
        return minimum, False
    latest = max(v for v, _ in candidates)
    # Old drafts count as allocated versions; never overwrite another commit.
    next_version = max(floor, (latest[0], latest[1], latest[2] + 1))
    return '.'.join(map(str, next_version)), False


if __name__ == '__main__':
    result = plan(os.environ['FFD_EVENT'], os.environ['FFD_REF'],
                  os.environ.get('FFD_TARGET', ''), os.environ.get('FFD_PUBLISH', 'false'))
    release = json.loads(Path('release.json').read_text(encoding='utf-8'))
    if not re.fullmatch(r'\d+\.\d+\.\d+', release['version']):
        raise ValueError('Invalid app version')
    run_id, number = int(os.environ['FFD_RUN']), int(os.environ['FFD_NUMBER'])
    if run_id <= 0 or number <= 0:
        raise ValueError('Invalid workflow identity')
    version, skip = release['version'], False
    history = os.environ.get('FFD_RELEASE_HISTORY')
    if result['publish']:
        if not history:
            raise ValueError('Publication requires the current release history')
        version, skip = release_identity(version, json.loads(Path(history).read_text()), os.environ.get('FFD_SHA', ''))
    result.update(version=version, skip=skip,
                  app=version, build=max(release['build'], 2000 + number))
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8', newline='\n') as stream:
        for key, value in result.items():
            stream.write(f'{key}={json.dumps(value) if isinstance(value, (dict, bool)) else value}\n')
