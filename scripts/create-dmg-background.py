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
    start, end = (246, 249, 254), (232, 239, 249)
    draw.line((0, y, WIDTH * SCALE, y), fill=tuple(round(a + (b - a) * t) for a, b in zip(start, end)))

def font(size, chinese=False):
    path = '/System/Library/Fonts/PingFang.ttc' if chinese else '/System/Library/Fonts/SFNS.ttf'
    return ImageFont.truetype(path, size * SCALE)

def center(text, y, size, color, chinese=False):
    draw.text((WIDTH * SCALE / 2, y * SCALE), text, font=font(size, chinese), fill=color, anchor='mt')

# A restrained top label and a dedicated area for the two real Finder icons.
center('KEYBAY', 30, 20, '#16243E')
center('DATABASE WORKSPACE', 59, 10, '#627696')
draw.rounded_rectangle((64*SCALE, 98*SCALE, 596*SCALE, 266*SCALE), radius=20*SCALE,
                       fill='#FFFFFF', outline='#D6E1F0', width=round(1.2*SCALE))
# Subtle icon pedestals keep the real Finder icon positions (165, 169) and (495, 169) clear.
for cx in (165, 495):
    draw.rounded_rectangle(((cx - 56)*SCALE, 113*SCALE, (cx + 56)*SCALE, 225*SCALE), radius=22*SCALE,
                           fill='#F7FAFF', outline='#E6EEF9', width=SCALE)
draw.line((284*SCALE, 169*SCALE, 374*SCALE, 169*SCALE), fill='#5B6FD6', width=round(2.6*SCALE))
draw.line((362*SCALE, 158*SCALE, 374*SCALE, 169*SCALE, 362*SCALE, 180*SCALE),
          fill='#5B6FD6', width=round(2.6*SCALE), joint='curve')
center('将 Keybay 拖到 Applications 文件夹', 285, 16, '#1E3254', True)
center('当前版本尚未经过 Apple 公证', 327, 12, '#647896', True)
center('首次打开时，macOS 可能要求在“隐私与安全性”中确认。', 347, 11, '#647896', True)
output = ROOT / 'src-tauri' / 'dmg' / 'background.png'
output.parent.mkdir(parents=True, exist_ok=True)
image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS).save(output, optimize=True)
image.resize((WIDTH * 2, HEIGHT * 2), Image.Resampling.LANCZOS).save(output.with_name('background@2x.png'), optimize=True)
print(output)
