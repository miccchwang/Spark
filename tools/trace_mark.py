#!/usr/bin/env python3
"""Vectorize a flat monochrome line-art PNG/JPEG into a clean SVG path.

Usage: trace_mark.py SRC OUT [epsilon] [pad] [color] [threshold]
"""
import sys, math
import numpy as np
import cv2

SRC = sys.argv[1]
OUT = sys.argv[2]
EPS = float(sys.argv[3]) if len(sys.argv) > 3 else 1.6
PAD = float(sys.argv[4]) if len(sys.argv) > 4 else 8.0
COLOR = sys.argv[5] if len(sys.argv) > 5 else "#000000"
THRESH = float(sys.argv[6]) if len(sys.argv) > 6 else 140.0

img = cv2.imread(SRC, cv2.IMREAD_GRAYSCALE)
if img is None:
    raise SystemExit("cannot read " + SRC)
# foreground = dark pixels
_, bw = cv2.threshold(img, THRESH, 255, cv2.THRESH_BINARY_INV)
# remove speckle
bw = cv2.morphologyEx(bw, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

contours, hierarchy = cv2.findContours(bw, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
if not contours:
    raise SystemExit("no contours")
hierarchy = hierarchy[0]

x, y, w, h = cv2.boundingRect(bw)
scale = 1.0
ox, oy = x - PAD, y - PAD
W, H = w + PAD * 2, h + PAD * 2


def corner_flags(pts, thresh_deg=52.0):
    """Mark vertices where the turn is sharp."""
    n = len(pts)
    flags = [False] * n
    for i in range(n):
        a = pts[(i - 1) % n]
        b = pts[i]
        c = pts[(i + 1) % n]
        v1 = (b[0] - a[0], b[1] - a[1])
        v2 = (c[0] - b[0], c[1] - b[1])
        n1 = math.hypot(*v1)
        n2 = math.hypot(*v2)
        if n1 < 1e-6 or n2 < 1e-6:
            flags[i] = True
            continue
        cosang = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
        ang = math.degrees(math.acos(max(-1.0, min(1.0, cosang))))
        if ang > thresh_deg:
            flags[i] = True
    return flags


def catmull_bezier(p0, p1, p2, p3, k=1.0 / 6.0):
    c1 = (p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k)
    c2 = (p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k)
    return c1, c2


def fmt(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def contour_to_path(pts):
    """Emit smooth cubic path, keeping sharp corners sharp."""
    n = len(pts)
    if n < 3:
        return ""
    flags = corner_flags(pts)
    # index list of corner positions
    corners = [i for i in range(n) if flags[i]]
    if len(corners) < 2:
        # fully smooth closed curve
        corners = [0]
    d = []
    start = corners[0]
    d.append(f"M{fmt(pts[start][0])} {fmt(pts[start][1])}")
    # walk segment by segment between corners
    for ci in range(len(corners)):
        i0 = corners[ci]
        i1 = corners[(ci + 1) % len(corners)]
        # collect vertex indices from i0..i1 inclusive (mod n)
        idx = []
        j = i0
        while True:
            idx.append(j % n)
            if j % n == i1 % n and len(idx) > 1:
                break
            j += 1
            if len(idx) > n + 1:
                break
        seg = [pts[k] for k in idx]
        if len(seg) < 3:
            if len(seg) == 2:
                d.append(f"L{fmt(seg[-1][0])} {fmt(seg[-1][1])}")
            continue
        # smooth interior of segment
        for m in range(1, len(seg) - 1):
            p0 = seg[m - 1]
            p1 = seg[m]
            p2 = seg[m + 1]
            p3 = seg[m + 2] if m + 2 < len(seg) else seg[-1]
            c1, c2 = catmull_bezier(p0, p1, p2, p3)
            d.append(
                f"C{fmt(c1[0])} {fmt(c1[1])} {fmt(c2[0])} {fmt(c2[1])} {fmt(p2[0])} {fmt(p2[1])}"
            )
        # close the segment at the corner
        if seg[-1] != seg[-2]:
            d.append(f"L{fmt(seg[-1][0])} {fmt(seg[-1][1])}")
    d.append("Z")
    return "".join(d)


paths = []
for i, c in enumerate(contours):
    if cv2.contourArea(c) < 40:
        continue
    arr = cv2.approxPolyDP(c, EPS, True).reshape(-1, 2).astype(float)
    arr[:, 0] -= ox
    arr[:, 1] -= oy
    approx = [(float(p[0]), float(p[1])) for p in arr]
    sub = contour_to_path(approx)
    if sub:
        paths.append(sub)

d_all = " ".join(paths)
svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(W)} {fmt(H)}" width="{fmt(W)}" height="{fmt(H)}" role="img" aria-label="spark">
  <path d="{d_all}" fill="{COLOR}" fill-rule="evenodd"/>
</svg>
'''
with open(OUT, "w") as f:
    f.write(svg)
print(f"wrote {OUT} viewBox 0 0 {W:.0f} {H:.0f}, subpaths={len(paths)}, chars={len(d_all)}")
