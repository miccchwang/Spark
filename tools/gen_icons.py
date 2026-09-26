#!/usr/bin/env python3
"""Generate Spark launcher icons and splash screens (run with the managed venv python)."""
import math
import os
import struct
import sys
from PIL import Image, ImageDraw, ImageFilter

RES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')
RES = os.path.abspath(RES)

ORANGE_HI = (255, 214, 140)
ORANGE_LO = (255, 90, 20)
BG_HI = (32, 35, 46)
BG_LO = (10, 11, 16)


def png_size(path):
    with open(path, 'rb') as f:
        d = f.read(33)
    return struct.unpack('>II', d[16:24])


def gradient(size, c1, c2):
    g = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(g)
    for y in range(size):
        t = y / max(1, size - 1)
        d.line([(0, y), (size, y)], fill=tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)))
    return g.convert('RGBA')


def star_points(cx, cy, r_out, r_in, n=4, rot=-math.pi / 2):
    pts = []
    for i in range(n * 2):
        r = r_out if i % 2 == 0 else r_in
        a = rot + i * math.pi / n
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def compose(size, mode):
    """mode: legacy | round | adaptive | splash"""
    SS = 4
    S = size * SS
    w, h = (S, S) if mode != 'splash' else (size * SS, size * SS)
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))

    if mode in ('legacy', 'round', 'splash'):
        bg = gradient(S, BG_HI, BG_LO)
        rad = Image.new('L', (S, S), 0)
        ImageDraw.Draw(rad).ellipse([S * 0.02, S * 0.02, S * 0.98, S * 0.98], fill=110)
        rad = rad.filter(ImageFilter.GaussianBlur(S * 0.13))
        glow = Image.new('RGBA', (S, S), (255, 122, 24, 90))
        canvas = Image.alpha_composite(canvas, Image.composite(glow, Image.new('RGBA', (S, S), (0, 0, 0, 0)), rad))
        canvas = Image.alpha_composite(canvas, bg.point(lambda v: v) if False else bg)

    cx, cy = w / 2, h / 2
    frac = 0.30 if mode in ('legacy', 'round') else (0.23 if mode == 'adaptive' else 0.16)
    r_out = min(w, h) * frac
    r_in = r_out * 0.33

    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).polygon(star_points(cx, cy, r_out, r_in), fill=255)

    glow = mask.filter(ImageFilter.GaussianBlur(min(w, h) * 0.045))
    glow_layer = Image.new('RGBA', (w, h), (255, 138, 40, 255))
    glow_layer.putalpha(glow.point(lambda v: int(v * 0.8)))
    canvas = Image.alpha_composite(canvas, glow_layer)

    star = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    star.paste(gradient(S, ORANGE_HI, ORANGE_LO).resize((w, h)), (0, 0), mask)
    canvas = Image.alpha_composite(canvas, star)

    if mode == 'round':
        am = Image.new('L', (S, S), 0)
        ImageDraw.Draw(am).ellipse([0, 0, S - 1, S - 1], fill=255)
        canvas.putalpha(Image.composite(Image.new('L', (S, S), 255), Image.new('L', (S, S), 0), am))

    return canvas.resize((size, size) if mode != 'splash' else (size, size), Image.LANCZOS)


def main():
    legacy = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    adaptive = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}

    for dpi, size in legacy.items():
        compose(size, 'legacy').save(os.path.join(RES, 'mipmap-' + dpi, 'ic_launcher.png'))
        compose(size, 'round').save(os.path.join(RES, 'mipmap-' + dpi, 'ic_launcher_round.png'))
    for dpi, size in adaptive.items():
        compose(size, 'adaptive').save(os.path.join(RES, 'mipmap-' + dpi, 'ic_launcher_foreground.png'))
    print('icons written')

    # splash: keep existing dimensions
    for name in ('splash.png',):
        for dpi in ('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'):
            for sub in ('drawable', 'drawable-port-' + dpi, 'drawable-land-' + dpi):
                p = os.path.join(RES, sub, name)
                if not os.path.isfile(p):
                    continue
                w, h = png_size(p)
                img = Image.new('RGBA', (w, h), (0, 0, 0, 255))
                bg = gradient(max(w, h), BG_HI, BG_LO).resize((w, h))
                img = Image.alpha_composite(img, bg)
                glyph_size = int(min(w, h) * 0.9)
                g = compose(glyph_size, 'adaptive')
                img.alpha_composite(g, ((w - glyph_size) // 2, (h - glyph_size) // 2))
                img.convert('RGB').save(p)
    print('splash written')


if __name__ == '__main__':
    main()
