#!/usr/bin/env python3
"""Generate the app's original chat/bridge icon (build-time Pillow only)."""
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
icons = root / "build" / "SessionBridge.iconset"
icons.mkdir(parents=True, exist_ok=True)
canvas = Image.new("RGBA", (1024, 1024))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((70, 70, 954, 954), radius=205, fill="#EAEAE3")
draw.ellipse((204, 204, 820, 820), fill="#DEE7D6")
# Original Sidekick linked-chat mark, matching the HTML and SwiftUI paths.
def point(x, y):
    return (272 + x * 20, 272 + y * 20)
def curve(start, c1, c2, end):
    result = []
    for i in range(61):
        t = i / 60; u = 1 - t
        result.append(point(*[u**3 * start[k] + 3*u*u*t*c1[k] + 3*u*t*t*c2[k] + t**3*end[k] for k in (0, 1)]))
    return result
paths = [
    [point(15, 4), point(8, 4)] + curve((8,4), (1.3,4), (1.3,14), (8,14)) + [point(10,14)],
    [point(9,20), point(16,20)] + curve((16,20), (22.7,20), (22.7,10), (16,10)) + [point(14,10)],
    [point(9,12), point(15,12)]
]
for path in paths:
    draw.line(path, fill="#3F542D", width=36, joint="curve")
    for x, y in (path[0], path[-1]):
        draw.ellipse((x-18,y-18,x+18,y+18),fill="#3F542D")
for size in [16, 32, 128, 256, 512]:
    for scale in [1, 2]:
        canvas.resize((size * scale, size * scale), Image.Resampling.LANCZOS).save(icons / f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png")
subprocess.run(["iconutil", "-c", "icns", str(icons), "-o", str(root / "macos" / "SessionBridge.icns")], check=True)
