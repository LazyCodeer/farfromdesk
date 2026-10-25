"""Render identical UTF-8 installer assets on every build host."""
from pathlib import Path


def write_installer(source: Path, target: Path, version: str):
    text = source.read_text(encoding='utf-8').replace('0.7.0-preview.1', version)
    with target.open('w', encoding='utf-8', newline='\n') as stream:
        stream.write(text)
