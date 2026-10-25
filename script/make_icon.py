#!/usr/bin/env python3
"""Create the native icon from the finalized FFD brand asset using macOS tools."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parent.parent
source = root / 'macos/Sources/SessionBridge/Resources/Brand/ffd-icon.png'
icons = root / 'build/SessionBridge.iconset'
icons.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        target = icons / f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
        subprocess.run(['sips', '-z', str(size * scale), str(size * scale), str(source), '--out', str(target)], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['iconutil', '-c', 'icns', str(icons), '-o', str(root / 'macos/SessionBridge.icns')], check=True)
