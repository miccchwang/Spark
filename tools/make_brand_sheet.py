#!/usr/bin/env python3
"""Assemble a self-contained brand sheet (all artwork inlined) for review."""
import base64
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BRAND = os.path.join(ROOT, 'assets', 'brand')
SVG = os.path.join(BRAND, 'svg')
PNG = os.path.join(BRAND, 'png')
OUT = os.path.join(BRAND, 'brand-sheet.html')

INK = '#0F1115'
PAPER = '#FFFFFF'
ACCENT = '#FF8A3D'


def svg_uri(path):
    with open(path, 'rb') as f:
        return 'data:image/svg+xml;base64,' + base64.b64encode(f.read()).decode()


def png_uri(path):
    with open(path, 'rb') as f:
        return 'data:image/png;base64,' + base64.b64encode(f.read()).decode()


def wordmark_font_uri():
    """Subset Playfair Display to the letters used on this sheet, as woff2."""
    import io
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
    from fontTools import subset

    src = os.path.join(BRAND, 'fonts', 'PlayfairDisplay.ttf')
    font = TTFont(src)
    if 'fvar' in font:
        font = instancer.instantiateVariableFont(font, {'wght': 500}, inplace=False)
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['kern', 'liga']
    options.notdef_outline = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text='sparkAg')
    subsetter.subset(font)
    buf = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buf)
    return 'data:font/woff2;base64,' + base64.b64encode(buf.getvalue()).decode()


mark = svg_uri(os.path.join(SVG, 'spark-mark.svg'))
mark_w = svg_uri(os.path.join(SVG, 'spark-mark-white.svg'))
lockup = svg_uri(os.path.join(SVG, 'spark-logo-horizontal.svg'))
lockup_w = svg_uri(os.path.join(SVG, 'spark-logo-horizontal-white.svg'))
stacked = svg_uri(os.path.join(SVG, 'spark-logo-stacked.svg'))
favicon = svg_uri(os.path.join(SVG, 'spark-favicon.svg'))
appicon = png_uri(os.path.join(PNG, 'spark-appicon-1024.png'))
appicon180 = png_uri(os.path.join(PNG, 'spark-appicon-180.png'))
appicon32 = png_uri(os.path.join(PNG, 'spark-appicon-32.png'))
wordmark_font = wordmark_font_uri()

HTML = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spark — Brand Sheet</title>
<style>
  @font-face {{
    font-family: "Playfair Display";
    src: url("{wordmark_font}") format("woff2");
    font-weight: 500;
    font-style: normal;
    font-display: block;
  }}
  :root {{
    --ink: {INK};
    --paper: {PAPER};
    --accent: {ACCENT};
    --line: #E3E6EB;
    --muted: #6B7280;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    background: #F5F6F8;
    color: var(--ink);
    font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }}
  .wrap {{ max-width: 1080px; margin: 0 auto; padding: 56px 32px 96px; }}
  header {{ display: flex; align-items: center; justify-content: space-between; gap: 24px;
            padding-bottom: 28px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }}
  header img {{ height: 54px; display: block; }}
  .meta {{ text-align: right; font-size: 12px; color: var(--muted); line-height: 1.7; letter-spacing: .02em; }}
  .meta b {{ color: var(--ink); font-weight: 600; }}
  h2 {{ font-size: 13px; text-transform: uppercase; letter-spacing: .16em; color: var(--muted);
        font-weight: 600; margin: 56px 0 18px; }}
  .grid {{ display: grid; gap: 18px; }}
  .g2 {{ grid-template-columns: 1fr 1fr; }}
  .g3 {{ grid-template-columns: repeat(3, 1fr); }}
  .card {{ background: var(--paper); border: 1px solid var(--line); border-radius: 16px;
           padding: 34px 28px; display: flex; flex-direction: column; align-items: center;
           justify-content: center; gap: 18px; min-height: 190px; }}
  .card.dark {{ background: var(--ink); border-color: #232833; }}
  .card .cap {{ font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }}
  .card.dark .cap {{ color: #8B94A3; }}
  .card img {{ max-width: 100%; display: block; }}
  .mark-sm {{ height: 74px; }}
  .lock {{ height: 62px; }}
  .lock-lg {{ height: 78px; }}
  .stacked {{ height: 132px; }}
  .icon-lg {{ width: 132px; height: 132px; border-radius: 28px; }}
  .icon-row {{ display: flex; align-items: flex-end; gap: 22px; }}
  .icon-row img {{ border-radius: 22%; display: block; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  td, th {{ text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }}
  th {{ font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); font-weight: 600; }}
  .swatch {{ display: inline-block; width: 26px; height: 26px; border-radius: 7px;
             border: 1px solid var(--line); vertical-align: middle; margin-right: 10px; }}
  code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }}
  .type-sample {{ font-family: "Playfair Display", Georgia, serif; font-size: 58px; line-height: 1;
                  letter-spacing: .01em; margin: 0; }}
  .type-note {{ font-size: 12px; color: var(--muted); line-height: 1.8; }}
  ul {{ margin: 0; padding-left: 18px; font-size: 13px; color: var(--muted); line-height: 2; }}
  ul b {{ color: var(--ink); font-weight: 600; }}
  footer {{ margin-top: 64px; padding-top: 22px; border-top: 1px solid var(--line);
            font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }}
  @media (max-width: 720px) {{
    .g2, .g3 {{ grid-template-columns: 1fr; }}
    .meta {{ text-align: left; }}
  }}
</style>
</head>
<body>
<div class="wrap">

  <header>
    <img src="{lockup}" alt="spark">
    <div class="meta">
      <b>Brand identity</b><br>
      Voice-first idea capture<br>
      Monochrome · Serif · Line art
    </div>
  </header>

  <h2>Primary lockup</h2>
  <div class="grid g2">
    <div class="card"><img class="lock-lg" src="{lockup}" alt="spark lockup"><span class="cap">On paper</span></div>
    <div class="card dark"><img class="lock-lg" src="{lockup_w}" alt="spark lockup"><span class="cap">On ink</span></div>
  </div>

  <h2>Symbol</h2>
  <div class="grid g3">
    <div class="card"><img class="mark-sm" src="{mark}" alt="spark mark"><span class="cap">Mark</span></div>
    <div class="card dark"><img class="mark-sm" src="{mark_w}" alt="spark mark"><span class="cap">Mark reversed</span></div>
    <div class="card"><img class="stacked" src="{stacked}" alt="spark stacked"><span class="cap">Stacked</span></div>
  </div>

  <h2>App icon</h2>
  <div class="card">
    <div class="icon-row">
      <img src="{appicon}" alt="app icon 1024" style="width:132px;height:132px">
      <img src="{appicon180}" alt="app icon 180" style="width:88px;height:88px">
      <img src="{appicon32}" alt="app icon 32" style="width:44px;height:44px">
      <img src="{favicon}" alt="favicon" style="width:28px;height:28px">
    </div>
    <span class="cap">Black mark on a paper plate · scalable to 28px</span>
  </div>

  <h2>Typeface</h2>
  <div class="grid g2">
    <div class="card" style="align-items:flex-start;gap:10px">
      <p class="type-sample">spark</p>
      <span class="type-note"><b>Playfair Display</b> · Medium 500<br>Wordmark only, always lowercase, converted to outlines.</span>
    </div>
    <div class="card" style="align-items:flex-start;gap:10px">
      <p class="type-sample" style="font-family:-apple-system,'SF Pro Text','PingFang SC',sans-serif;font-size:34px;font-weight:600">Aa 灵感收件箱</p>
      <span class="type-note"><b>SF Pro / PingFang SC</b> · system UI stack<br>Interface copy and headings inside the product.</span>
    </div>
  </div>

  <h2>Palette</h2>
  <div class="card" style="align-items:stretch">
    <table>
      <tr><th>Role</th><th>Value</th><th>Use</th></tr>
      <tr><td><span class="swatch" style="background:{INK}"></span>Ink</td><td><code>{INK}</code></td><td>All logo artwork, dark UI surface</td></tr>
      <tr><td><span class="swatch" style="background:{PAPER}"></span>Paper</td><td><code>{PAPER}</code></td><td>Logo background, light UI surface</td></tr>
      <tr><td><span class="swatch" style="background:{ACCENT}"></span>Spark accent</td><td><code>{ACCENT}</code></td><td>In-product only: record button, active states. Never in the logo.</td></tr>
    </table>
  </div>

  <h2>Rules</h2>
  <div class="grid g2">
    <div class="card" style="align-items:flex-start">
      <span class="cap" style="color:var(--ink)">Do</span>
      <ul>
        <li>Keep the mark <b>black on paper</b> or <b>paper on ink</b>.</li>
        <li>Leave clear space of <b>half the mark height</b> on all sides.</li>
        <li>Minimum mark size <b>16px</b>, minimum lockup width <b>120px</b>.</li>
      </ul>
    </div>
    <div class="card" style="align-items:flex-start">
      <span class="cap" style="color:var(--ink)">Don't</span>
      <ul>
        <li>No gradients, shadows, glows or outlines.</li>
        <li>No colour, no tints, no rotation or stretching.</li>
        <li>Never set the wordmark in another typeface or in caps.</li>
      </ul>
    </div>
  </div>

  <footer>
    <span>spark · brand sheet v1.0</span>
    <span>assets/brand/ · svg + png + android mipmaps</span>
  </footer>
</div>
</body>
</html>
'''

with open(OUT, 'w') as f:
    f.write(HTML)
print('wrote', OUT, f'({len(HTML) / 1024:.0f} KB)')
