"""Select hosted build jobs before allocating expensive native runners."""
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
        # The workflow push filter permits only an explicit release.json change.
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


if __name__ == '__main__':
    result = plan(os.environ['FFD_EVENT'], os.environ['FFD_REF'],
                  os.environ.get('FFD_TARGET', ''), os.environ.get('FFD_PUBLISH', 'false'))
    release = json.loads(Path('release.json').read_text(encoding='utf-8'))
    if not re.fullmatch(r'\d+\.\d+\.\d+', release['version']):
        raise ValueError('Invalid app version')
    run_id, number = int(os.environ['FFD_RUN']), int(os.environ['FFD_NUMBER'])
    if run_id <= 0 or number <= 0:
        raise ValueError('Invalid workflow identity')
    result.update(version=f"{release['version']}-preview.{run_id}",
                  app=release['version'], build=max(release['build'], 2000 + number))
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8', newline='\n') as stream:
        for key, value in result.items():
            stream.write(f'{key}={json.dumps(value) if isinstance(value, (dict, bool)) else value}\n')
