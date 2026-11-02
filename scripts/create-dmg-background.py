#!/usr/bin/env python3
"""Generate the Finder DMG background (run on macOS with Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SCALE = 3
WIDTH, HEIGHT = 660, 400
image = Image.new('RGB', (WIDTH * SCALE, HEIGHT * SCALE))
draw = ImageDraw.Draw(image)
for y in range(HEIGHT * SCALE):
    t = y / (HEIGHT * SCALE - 1)
    start, end = (248, 250, 254), (235, 241, 249)
    draw.line((0, y, WIDTH * SCALE, y), fill=tuple(round(a + (b - a) * t) for a, b in zip(start, end)))

def font(size, chinese=False):
    path = '/System/Library/Fonts/PingFang.ttc' if chinese else '/System/Library/Fonts/SFNS.ttf'
    return ImageFont.truetype(path, size * SCALE)

def center(text, y, size, color, chinese=False):
    draw.text((WIDTH * SCALE / 2, y * SCALE), text, font=font(size, chinese), fill=color, anchor='mt')

# A restrained top label and a dedicated area for the two real Finder icons.
center('DB STUDIO', 32, 20, '#192B48')
center('DATABASE WORKSPACE', 61, 10, '#7488A5')
draw.rounded_rectangle((64*SCALE, 100*SCALE, 596*SCALE, 264*SCALE), radius=18*SCALE,
                       fill='#F7F9FD', outline='#DEE7F3', width=SCALE)
# The icons themselves are supplied by Finder. Keep their positions clear.
draw.line((288*SCALE, 169*SCALE, 372*SCALE, 169*SCALE), fill='#8299B9', width=3*SCALE)
draw.line((360*SCALE, 158*SCALE, 372*SCALE, 169*SCALE, 360*SCALE, 180*SCALE),
          fill='#8299B9', width=3*SCALE, joint='curve')
center('将 DB Studio 拖到 Applications 文件夹', 285, 16, '#263D61', True)
center('当前版本尚未经过 Apple 公证', 327, 12, '#687C98', True)
center('首次打开时，macOS 可能要求在“隐私与安全性”中确认。', 347, 11, '#687C98', True)
output = ROOT / 'src-tauri' / 'dmg' / 'background.png'
output.parent.mkdir(parents=True, exist_ok=True)
image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS).save(output, optimize=True)
image.resize((WIDTH * 2, HEIGHT * 2), Image.Resampling.LANCZOS).save(output.with_name('background@2x.png'), optimize=True)
print(output)
