#!/usr/bin/env python3
"""Generate Spark launcher icons and splash screens from the brand mark.

Source art: assets/brand/png/spark-mark-1024.png (black mark, transparent)
            assets/brand/png/spark-mark-white-1024.png (white mark, transparent)

Usage: python3 tools/gen_icons.py [res-dir]
"""
import os
import struct
import sys
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
RES = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else
                      os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res'))

BRAND = os.path.join(ROOT, 'assets', 'brand', 'png')
MARK_INK = os.path.join(BRAND, 'spark-mark-1024.png')
MARK_WHITE = os.path.join(BRAND, 'spark-mark-white-1024.png')

INK = (0, 0, 0, 255)
PAPER = (255, 255, 255, 255)
SPLASH_BG = (0, 0, 0, 255)
SS = 4  # supersampling


def png_size(path):
    with open(path, 'rb') as f:
        d = f.read(33)
    return struct.unpack('>II', d[16:24])


def load(path, color):
    """Load the mark and re-tint it to `color` (source art is flat monochrome)."""
    img = Image.open(path).convert('RGBA')
    bbox = img.getchannel('A').getbbox()
    if bbox:
        img = img.crop(bbox)
    out = Image.new('RGBA', img.size, color)
    out.putalpha(img.getchannel('A'))
    return out


def place_mark(canvas, mark, target_h, center, color):
    """Scale the mark to target_h and composite it centred on `canvas`."""
    m = load(mark, color)
    h = max(1, int(target_h))
    w = max(1, round(m.width * h / m.height))
    m = m.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(m, (int(center[0] - w / 2), int(center[1] - h / 2)))
    return canvas


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def circle_mask(size):
    m = Image.new('L', (size, size), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(m).ellipse([0, 0, size - 1, size - 1], fill=255)
    return m


def legacy_icon(size, shape):
    S = size * SS
    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    plate = Image.new('RGBA', (S, S), PAPER)
    canvas.alpha_composite(plate)
    place_mark(canvas, MARK_INK, S * 0.66, (S / 2, S / 2), INK)
    mask = circle_mask(S) if shape == 'round' else rounded_mask(S, int(S * 0.22))
    canvas.putalpha(mask)
    return canvas.resize((size, size), Image.LANCZOS)


def adaptive_foreground(size):
    """108dp canvas; the mark stays inside the 66dp guaranteed-visible circle."""
    S = size * SS
    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    place_mark(canvas, MARK_INK, S * 0.50, (S / 2, S / 2), INK)
    return canvas.resize((size, size), Image.LANCZOS)


def splash(w, h):
    S_W, S_H = w * SS, h * SS
    canvas = Image.new('RGBA', (S_W, S_H), SPLASH_BG)
    place_mark(canvas, MARK_WHITE, min(S_W, S_H) * 0.26, (S_W / 2, S_H / 2), PAPER)
    return canvas.resize((w, h), Image.LANCZOS).convert('RGB')


def main():
    legacy = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    adaptive = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}

    for dpi, size in legacy.items():
        legacy_icon(size, 'square').save(os.path.join(RES, 'mipmap-' + dpi, 'ic_launcher.png'))
        legacy_icon(size, 'round').save(os.path.join(RES, 'mipmap-' + dpi, 'ic_launcher_round.png'))
    for dpi, size in adaptive.items():
        adaptive_foreground(size).save(
            os.path.join(RES, 'mipmap-' + dpi, 'ic_launcher_foreground.png'))
    print('icons written')

    for dpi in ('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'):
        for sub in ('drawable', 'drawable-port-' + dpi, 'drawable-land-' + dpi):
            p = os.path.join(RES, sub, 'splash.png')
            if not os.path.isfile(p):
                continue
            w, h = png_size(p)
            splash(w, h).save(p)
    print('splash written')


if __name__ == '__main__':
    main()
