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

INK = '#0F1115'
PAPER = '#FFFFFF'
WORD = 'spark'
WEIGHT = 500
TRACKING = 0.012  # em, subtle letterspacing


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
def render_png(svg_text, size=1024):
    """Rasterise an SVG string with macOS Quick Look; return a PIL RGBA image."""
    tmpdir = tempfile.mkdtemp()
    svg_path = os.path.join(tmpdir, 'render.svg')
    with open(svg_path, 'w') as f:
        f.write(svg_text)
    try:
        subprocess.run(
            ['qlmanage', '-t', '-s', str(size), '-o', tmpdir, svg_path],
            capture_output=True, timeout=90,
        )
        out = os.path.join(tmpdir, 'render.svg.png')
        if not os.path.isfile(out):
            raise RuntimeError('render failed')
        img = Image.open(out).convert('RGBA').copy()
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


def square_viewbox(w, h, pad_ratio=0.10):
    side = max(w, h) * (1 + pad_ratio * 2)
    x = (w - side) / 2
    y = (h - side) / 2
    return f'{x:.1f} {y:.1f} {side:.1f} {side:.1f}'


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
        """Rasterise an SVG (Quick Look flattens onto white) and return the RGBA image."""
        text = open(os.path.join(SVG_DIR, svg_file)).read()
        vb_now = [float(v) for v in
                  text.split('viewBox="', 1)[1].split('"', 1)[0].split()]
        sq = square_viewbox(vb_now[2], vb_now[3], pad_ratio=0.02)
        text_sq = text.replace(
            f'viewBox="{vb_now[0]:.1f} {vb_now[1]:.1f} {vb_now[2]:.1f} {vb_now[3]:.1f}"',
            f'viewBox="{sq}"')
        return render_png(text_sq, 1024)

    def recolor(img, rgb):
        """Rebuild a transparent image in `rgb` from dark-art-on-white artwork."""
        lum = img.convert('L')
        out = Image.new('RGBA', img.size, rgb + (0,))
        out.putalpha(Image.eval(lum, lambda v: 255 - v))
        return out

    exports = [
        ('spark-mark.svg', 'spark-mark', (15, 17, 21)),
        ('spark-mark.svg', 'spark-mark-white', (255, 255, 255)),
        ('spark-logo-horizontal.svg', 'spark-logo-horizontal', (15, 17, 21)),
        ('spark-logo-horizontal.svg', 'spark-logo-horizontal-white', (255, 255, 255)),
        ('spark-logo-stacked.svg', 'spark-logo-stacked', (15, 17, 21)),
        ('spark-logo-stacked.svg', 'spark-logo-stacked-white', (255, 255, 255)),
    ]
    for svg_file, name, rgb in exports:
        save_png_set(recolor(raster(svg_file), rgb), name)

    # ---------------- app icon (black mark on a white plate) ----------------
    mark_img = autocrop(recolor(raster('spark-mark.svg'), (15, 17, 21)), pad=1)
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

    print('brand kit written to', os.path.dirname(PNG_DIR))


if __name__ == '__main__':
    main()
