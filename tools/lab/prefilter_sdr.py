#!/usr/bin/env python3
"""Porta numpy di f_dn e f_jnd (tools/diag/sdr8.html, WGSL fsDn / jnd), applicati a frame SDR RGB 8 bit (dopo il tone map).
Uso: prefilter_sdr.py W H {dn|jnd|dnjnd|none} [dn_strength=0.5] [dn_sigma=4] [jnd_cap=0.6] < rgb24 > rgb24
Fedeltà: dn: w=k·exp(-(|Δluma|·255/sig)²), r=mix(c,hist,w); hist=uscita float del frame precedente (rgba16float nel browser, qui float32),
frame 0 con k=0. jnd: smoothing gaussiano 3×3 (1-2-1) limitato a ±u.k·th/255 con th dalla soglia JND (luminanza di sfondo + gradiente Sobel),
bordi clamp. Luma Rec.709 sui valori gamma (R'G'B'). Uscita arrotondata a 8 bit (rgba8unorm)."""
import sys, numpy as np
W, H, mode = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
K = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
SIG = float(sys.argv[5]) if len(sys.argv) > 5 else 4.0
CAP = float(sys.argv[6]) if len(sys.argv) > 6 else 0.6
L = np.array([0.2126, 0.7152, 0.0722], np.float32)
luma = lambda c: c @ L
def jnd(c):  # c float32 HxWx3 in [0,1]
    p = np.pad(c, ((1, 1), (1, 1), (0, 0)), mode='edge')
    sh = lambda j, i: p[j:j + H, i:i + W]
    w = [1, 2, 1, 2, 4, 2, 1, 2, 1]
    cs = [sh(j, i) for j in range(3) for i in range(3)]
    ls = [luma(x) * 255 for x in cs]
    bl = sum(x * (wk / 16.0) for x, wk in zip(cs, w)); bg = sum(ls) / 9.0
    gx = (ls[2] + 2 * ls[5] + ls[8]) - (ls[0] + 2 * ls[3] + ls[6]); gy = (ls[6] + 2 * ls[7] + ls[8]) - (ls[0] + 2 * ls[1] + ls[2])
    g = (np.abs(gx) + np.abs(gy)) / 8.0
    tl = np.where(bg <= 127, 17.0 * (1 - np.sqrt(np.maximum(bg, 0) / 127.0)) + 3.0, 3.0 / 128.0 * (bg - 127.0) + 3.0)
    tt = 0.117 * g * 4.0; th = tl + tt - 0.3 * np.minimum(tl, tt); lim = (CAP * th / 255.0)[..., None]
    return cs[4] + np.clip(bl - cs[4], -lim, lim)
q = lambda x: np.clip(np.rint(x * 255), 0, 255).astype(np.uint8)
hist = None; n = W * H * 3
rd, wr = sys.stdin.buffer, sys.stdout.buffer
while True:
    b = rd.read(n)
    if len(b) < n: break
    c = np.frombuffer(b, np.uint8).reshape(H, W, 3).astype(np.float32) / 255.0
    if mode in ('dn', 'dnjnd'):
        if hist is None: r = c
        else:
            d = np.abs(luma(c) - luma(hist)) * 255.0 / SIG
            w = (K * np.exp(-d * d))[..., None]; r = c + (hist - c) * w
        hist = r; c = r
        c = q(c).astype(np.float32) / 255.0 if mode == 'dnjnd' else c
    if mode in ('jnd', 'dnjnd'): c = jnd(c)
    wr.write(q(c).tobytes())
