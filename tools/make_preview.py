#!/usr/bin/env python3
"""Bundle www/ into a single self-contained preview file at dist/Spark-preview.html."""
import base64
import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WWW = os.path.join(ROOT, 'www')
OUT = os.path.join(ROOT, 'dist', 'Spark-preview.html')


def data_uri(path, mime):
    with open(path, 'rb') as f:
        return f'data:{mime};base64,' + base64.b64encode(f.read()).decode()


def main():
    html = open(os.path.join(WWW, 'index.html')).read()
    css = open(os.path.join(WWW, 'css', 'app.css')).read()

    # brand art referenced from CSS and HTML has to travel inside the file
    mark = data_uri(os.path.join(WWW, 'assets', 'brand', 'spark-mark.svg'), 'image/svg+xml')
    favicon = data_uri(os.path.join(WWW, 'assets', 'brand', 'spark-favicon.svg'), 'image/svg+xml')
    touch = data_uri(os.path.join(WWW, 'assets', 'brand', 'app-icon-180.png'), 'image/png')
    icon32 = data_uri(os.path.join(WWW, 'assets', 'brand', 'app-icon-32.png'), 'image/png')
    wordmark = data_uri(os.path.join(WWW, 'fonts', 'playfair-wordmark.woff2'), 'font/woff2')

    css = css.replace('../assets/brand/spark-mark.svg', mark)
    css = css.replace('../fonts/playfair-wordmark.woff2', wordmark)
    html = html.replace('<link rel="stylesheet" href="css/app.css">', f'<style>\n{css}\n</style>')
    html = html.replace('assets/brand/spark-favicon.svg', favicon)
    html = html.replace('assets/brand/app-icon-180.png', touch)
    html = html.replace('assets/brand/app-icon-32.png', icon32)

    for name in ('db.js', 'zip.js', 'backup.js', 'recorder.js', 'speech.js', 'dnd.js', 'app.js'):
        src = open(os.path.join(WWW, 'js', name)).read()
        html = html.replace(f'<script src="js/{name}"></script>', f'<script>\n{src}\n</script>')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        f.write(html)
    left = re.findall(r'(?:src|href)="(?!data:|#|https?:)[^"]+"', html)
    print(f'wrote {OUT} ({len(html) / 1024:.0f} KB), unresolved refs: {left or "none"}')


if __name__ == '__main__':
    main()
