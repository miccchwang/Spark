#!/usr/bin/env python3
"""Build the Spark brand kit.

Inputs:
  assets/brand/concepts/*.png        AI-rendered logo concepts (source art)
  assets/brand/svg/spark-mark.svg    traced vector mark (produced by tools/trace_mark.py)

Outputs:
  assets/brand/svg/*.svg             vector lockups (mark + outlined serif wordmark)
  assets/brand/png/*.png             raster exports at 1024/512/256/128/64
  assets/brand/brand-sheet.svg       overview sheet

Usage: python3 tools/make_brand.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.misc.transform import Transform
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SVG_DIR = os.path.join(ROOT, 'assets', 'brand', 'svg')
PNG_DIR = os.path.join(ROOT, 'assets', 'brand', 'png')
MARK_SRC = os.path.join(SVG_DIR, 'spark-mark.svg')
FONT_SRC = os.path.join(ROOT, 'assets', 'brand', 'fonts', 'PlayfairDisplay.ttf')

INK = '#000000'
PAPER = '#FFFFFF'
WORD = 'spark'
WEIGHT = 500
TRACKING = 0.012  # em, subtle letterspacing

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


# ---------------------------------------------------------------- wordmark ---
def build_wordmark(font_path, text=WORD, weight=WEIGHT, unit=1000.0):
    """Return (svg_path_data, advance_width, bbox) for text at font-size `unit`."""
    font = TTFont(font_path)
    if 'fvar' in font:
        font = instancer.instantiateVariableFont(font, {'wght': weight}, inplace=False)
    tmp = tempfile.NamedTemporaryFile(suffix='.ttf', delete=False)
    tmp.close()
    font.save(tmp.name)

    import uharfbuzz as hb
    with open(tmp.name, 'rb') as f:
        data = f.read()
    os.unlink(tmp.name)

    face = hb.Face(data)
    hbfont = hb.Font(face)
    upem = face.upem
    scale = unit / upem

    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbfont, buf, {'kern': True, 'liga': True})

    glyph_set = font.getGlyphSet()
    order = font.getGlyphOrder()
    tracking = TRACKING * unit

    parts = []
    pen_x = 0.0
    bounds = BoundsPen(glyph_set)
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        gname = order[info.codepoint]
        glyph = glyph_set[gname]
        dx = (pen_x + pos.x_offset) * scale
        dy = -pos.y_offset * scale
        t = Transform(scale, 0, 0, -scale, dx, dy)

        spen = SVGPathPen(glyph_set)
        glyph.draw(TransformPen(spen, t))
        cmds = spen.getCommands()
        if cmds:
            parts.append(cmds)
        glyph.draw(TransformPen(bounds, t))
        pen_x += pos.x_advance + (tracking / scale)

    d = ' '.join(p for p in parts if p)
    x0, y0, x1, y1 = bounds.bounds
    return d, pen_x * scale - tracking, (x0, y0, x1, y1)


# --------------------------------------------------------------- mark data ---
def read_mark():
    """Pull the traced path out of spark-mark.svg and measure its true ink bounds."""
    src = open(MARK_SRC).read()
    d = src.split('d="', 1)[1].split('"', 1)[0]
    nums = [float(n) for n in re.findall(r'-?\d+(?:\.\d+)?', d)]
    xs = nums[0::2]
    ys = nums[1::2]
    x0, y0 = min(xs), min(ys)
    w, h = max(xs) - x0, max(ys) - y0
    return d, [x0, y0, w, h]


# ------------------------------------------------------------------ render ---
def subset_woff2(font_path, text, weight=WEIGHT):
    """Return a woff2 byte string containing only the glyphs in `text`."""
    import io
    from fontTools import subset as ft_subset

    font = TTFont(font_path)
    if 'fvar' in font:
        font = instancer.instantiateVariableFont(font, {'wght': weight}, inplace=False)
    options = ft_subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['kern', 'liga']
    options.notdef_outline = True
    subsetter = ft_subset.Subsetter(options=options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    buf = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buf)
    return buf.getvalue()


def render_png(svg_text, size=1024):
    """Rasterise an SVG string with headless Chrome; returns a PIL RGBA image.

    Chrome renders at the exact aspect ratio with a transparent background,
    unlike Quick Look which flattens onto white and crops to a square.
    """
    tmpdir = tempfile.mkdtemp()
    svg_path = os.path.join(tmpdir, 'art.svg')
    html_path = os.path.join(tmpdir, 'art.html')
    png_path = os.path.join(tmpdir, 'art.png')
    with open(svg_path, 'w') as f:
        f.write(svg_text)

    vb = [float(v) for v in svg_text.split('viewBox="', 1)[1].split('"', 1)[0].split()]
    ar = vb[2] / vb[3]
    if ar >= 1:
        w, h = size, max(1, round(size / ar))
    else:
        h, w = size, max(1, round(size * ar))
    html = ('<!DOCTYPE html><html><head><style>'
            'html,body{margin:0;padding:0;background:transparent}'
            f'img{{display:block;width:{w}px;height:{h}px}}'
            '</style></head><body><img src="art.svg"></body></html>')
    with open(html_path, 'w') as f:
        f.write(html)

    try:
        subprocess.run(
            [CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
             '--default-background-color=00000000', '--force-device-scale-factor=1',
             f'--window-size={w},{h}', f'--screenshot={png_path}', html_path],
            capture_output=True, timeout=120,
        )
        if not os.path.isfile(png_path):
            raise RuntimeError('chrome render failed')
        img = Image.open(png_path).convert('RGBA').copy()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return img


def autocrop(img, pad=0):
    bbox = img.getchannel('A').getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(img.width, x1 + pad), min(img.height, y1 + pad)
    return img.crop((x0, y0, x1, y1))


def save_png_set(img, name, sizes=(1024, 512, 256, 128, 64)):
    img = autocrop(img, pad=2)
    for s in sizes:
        out = img.copy()
        out.thumbnail((s, s), Image.LANCZOS)
        out.save(os.path.join(PNG_DIR, f'{name}-{s}.png'))


def svg_doc(viewbox, body, w=None, h=None, bg=None):
    dims = ''
    if w:
        dims = f' width="{w:.0f}" height="{h:.0f}"'
    rect = f'\n  <rect x="{viewbox[0]}" y="{viewbox[1]}" width="{viewbox[2]}" height="{viewbox[3]}" fill="{bg}"/>' if bg else ''
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox[0]:.1f} {viewbox[1]:.1f} '
        f'{viewbox[2]:.1f} {viewbox[3]:.1f}"{dims} role="img" aria-label="spark">{rect}\n'
        f'{body}\n</svg>\n'
    )


# -------------------------------------------------------------------- main ---
def main():
    os.makedirs(PNG_DIR, exist_ok=True)
    mark_d, mark_vb = read_mark()
    mw, mh = mark_vb[2], mark_vb[3]

    word_d, word_w, word_bbox = build_wordmark(FONT_SRC)
    wx0, wy0, wx1, wy1 = word_bbox
    # Playfair x-height measured from the 'a' bowl, used for optical centring
    X_HEIGHT = 0.494

    print(f'mark  {mw:.0f} x {mh:.0f}')
    print(f'word  advance {word_w:.0f}, bbox x {wx0:.0f}..{wx1:.0f} y {wy0:.0f}..{wy1:.0f}')

    def mark_group(scale, tx, ty, fill):
        return (f'  <g transform="translate({tx:.2f} {ty:.2f}) scale({scale:.5f})">\n'
                f'    <path d="{mark_d}" fill="{fill}" fill-rule="evenodd"/>\n'
                f'  </g>')

    def word_group(scale, tx, ty, fill):
        return (f'  <g transform="translate({tx:.2f} {ty:.2f}) scale({scale:.5f})">\n'
                f'    <path d="{word_d}" fill="{fill}"/>\n'
                f'  </g>')

    def lockup(mark_h, font_size, gap_ratio, stack=False, fill=INK):
        """Lay out mark + wordmark and return (viewBox, body) with a tight fit."""
        m_scale = mark_h / mh
        mark_w = mw * m_scale
        w_scale = font_size / 1000.0
        word_adv = word_w * w_scale
        gap = gap_ratio * mark_h

        if stack:
            word_ink_h = (wy1 - wy0) * w_scale
            width = max(mark_w, word_adv)
            mark_x = (width - mark_w) / 2
            word_x = (width - word_adv) / 2 - wx0 * w_scale
            baseline = mark_h + gap - wy0 * w_scale
            mark_y = 0.0
            boxes = [(mark_x, mark_y, mark_x + mark_w, mark_y + mark_h),
                     (word_x + wx0 * w_scale, baseline + wy0 * w_scale,
                      word_x + wx1 * w_scale, baseline + wy1 * w_scale)]
        else:
            word_block_h = (wy1 - wy0) * w_scale
            baseline = (mark_h - word_block_h) / 2 - wy0 * w_scale
            x_band_centre = baseline - (X_HEIGHT * 1000.0 / 2) * w_scale
            mark_y = x_band_centre - mark_h / 2
            mark_x = 0.0
            word_x = mark_w + gap - wx0 * w_scale
            boxes = [(mark_x, mark_y, mark_x + mark_w, mark_y + mark_h),
                     (word_x + wx0 * w_scale, baseline + wy0 * w_scale,
                      word_x + wx1 * w_scale, baseline + wy1 * w_scale)]

        x0 = min(b[0] for b in boxes)
        y0 = min(b[1] for b in boxes)
        x1 = max(b[2] for b in boxes)
        y1 = max(b[3] for b in boxes)
        pad = 0.10 * mark_h
        dx, dy = pad - x0, pad - y0
        vb = [0, 0, (x1 - x0) + pad * 2, (y1 - y0) + pad * 2]
        body = '\n'.join([
            mark_group(m_scale, mark_x + dx, mark_y + dy, fill),
            word_group(w_scale, word_x + dx, baseline + dy, fill),
        ])
        return vb, body

    # ---------------- horizontal lockup ----------------
    M_H = 1000.0
    vb, body = lockup(M_H, 0.62 * M_H, 0.30)
    open(os.path.join(SVG_DIR, 'spark-logo-horizontal.svg'), 'w').write(svg_doc(vb, body))
    _, body_w = lockup(M_H, 0.62 * M_H, 0.30, fill=PAPER)
    open(os.path.join(SVG_DIR, 'spark-logo-horizontal-white.svg'), 'w').write(svg_doc(vb, body_w))
    open(os.path.join(SVG_DIR, 'spark-logo-horizontal-onwhite.svg'), 'w').write(
        svg_doc(vb, body, bg=PAPER))

    # ---------------- stacked lockup ----------------
    s_vb, s_body = lockup(M_H, 0.30 * M_H, 0.16, stack=True)
    open(os.path.join(SVG_DIR, 'spark-logo-stacked.svg'), 'w').write(svg_doc(s_vb, s_body))

    # ---------------- mark only ----------------
    for name, fill in (('spark-mark.svg', INK), ('spark-mark-white.svg', PAPER)):
        d = mark_d
        pad_m = 0.06 * max(mw, mh)
        body = f'  <path d="{d}" fill="{fill}" fill-rule="evenodd"/>'
        open(os.path.join(SVG_DIR, name), 'w').write(
            svg_doc([-pad_m, -pad_m, mw + pad_m * 2, mh + pad_m * 2], body))

    # ---------------- PNG exports ----------------
    def raster(svg_file):
        return render_png(open(os.path.join(SVG_DIR, svg_file)).read(), 1024)

    def recolor(img, rgb):
        """Re-tint rendered artwork: Chrome output is ink-on-transparent, so the
        alpha channel already carries the shape."""
        alpha = img.getchannel('A')
        if alpha.getextrema() == (255, 255):           # flattened onto white
            alpha = Image.eval(img.convert('L'), lambda v: 255 - v)
        out = Image.new('RGBA', img.size, rgb + (0,))
        out.putalpha(alpha)
        return out

    exports = [
        ('spark-mark.svg', 'spark-mark', (0, 0, 0)),
        ('spark-mark.svg', 'spark-mark-white', (255, 255, 255)),
        ('spark-logo-horizontal.svg', 'spark-logo-horizontal', (0, 0, 0)),
        ('spark-logo-horizontal.svg', 'spark-logo-horizontal-white', (255, 255, 255)),
        ('spark-logo-stacked.svg', 'spark-logo-stacked', (0, 0, 0)),
        ('spark-logo-stacked.svg', 'spark-logo-stacked-white', (255, 255, 255)),
    ]
    for svg_file, name, rgb in exports:
        save_png_set(recolor(raster(svg_file), rgb), name)

    # ---------------- app icon (black mark on a white plate) ----------------
    mark_img = autocrop(recolor(raster('spark-mark.svg'), (0, 0, 0)), pad=1)
    PLATE = 1024
    icon_h = int(PLATE * 0.66)
    icon_w = round(mark_img.width * icon_h / mark_img.height)
    mark_img = mark_img.resize((icon_w, icon_h), Image.LANCZOS)
    plate = Image.new('RGBA', (PLATE, PLATE), (255, 255, 255, 255))
    plate.alpha_composite(mark_img, ((PLATE - icon_w) // 2, (PLATE - icon_h) // 2))
    for s in (1024, 512, 180, 120, 32):
        plate.resize((s, s), Image.LANCZOS).save(
            os.path.join(PNG_DIR, f'spark-appicon-{s}.png'))

    # ---------------- favicon (self-contained SVG) ----------------
    fav_scale = icon_h / mh
    fav_tx = (PLATE - icon_w) / 2 - mark_vb[0] * fav_scale
    fav_ty = (PLATE - icon_h) / 2 - mark_vb[1] * fav_scale
    fav_body = (f'  <rect width="{PLATE}" height="{PLATE}" fill="{PAPER}"/>\n'
                f'  <g transform="translate({fav_tx:.2f} {fav_ty:.2f}) scale({fav_scale:.5f})">\n'
                f'    <path d="{mark_d}" fill="{INK}" fill-rule="evenodd"/>\n'
                f'  </g>')
    open(os.path.join(SVG_DIR, 'spark-favicon.svg'), 'w').write(
        svg_doc([0, 0, PLATE, PLATE], fav_body))

    # ---------------- web wordmark font (tiny subset for the app) ----------------
    web_fonts = os.path.join(ROOT, 'www', 'fonts')
    os.makedirs(web_fonts, exist_ok=True)
    subset = subset_woff2(FONT_SRC, 'sparkSPARK0123456789:.,·')
    with open(os.path.join(web_fonts, 'playfair-wordmark.woff2'), 'wb') as f:
        f.write(subset)
    print(f'web wordmark font: {len(subset) / 1024:.1f} KB')

    print('brand kit written to', os.path.dirname(PNG_DIR))


if __name__ == '__main__':
    main()
