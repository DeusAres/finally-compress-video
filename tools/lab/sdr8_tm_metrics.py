#!/usr/bin/env python3
"""Misure oggettive delle varianti di tone map HLG -> SDR di tools/diag/sdr8.html (?tm=), sul frame centrale di un video HLG.

Uso: python3 -I tools/lab/sdr8_tm_metrics.py samples/IMG_2147.mov [...]   env: J (bt2408), JA/BA/SA (apple), ENC=1886|709
La matematica replica lo shader WGSL (funzioni sdr/c2446/mob/apple/hlgsdr/gam/enc): ingresso NV12 8 bit HLG grezzo come VideoDecoder.
Riferimenti: «iphone» = luce del display / 203 nit (bianco di riferimento HDR = bianco SDR, ITU-R BT.2408), alte luci tagliate:
approssima l'originale su iPhone sotto il bianco di riferimento; «mob100»/«mob203» = ffmpeg zscale + tonemap=mobius (npl 100 / 203).
Colonne (codici 8 bit BT.709 limitati): Ymean, Ystd (contrasto), sat = media |CbCr|, satPP = |CbCr| su rosa/viola/magenta,
clip% = Y >= 233, dark% = Y <= 24, hiStd/shStd = Ystd dei pixel sopra 203 nit / sotto 5 nit (dettaglio in alte luci / ombre),
dY/dC = scarto medio da «iphone» sui pixel sotto 203 nit (dove il riferimento è esatto), poi da mob203.
"""
import os, subprocess, sys, tempfile
import numpy as np

LW, REF, GT, J = 1000.0, 203.0, 0.8, float(os.environ.get('J', '0.5'))
XA, SAT3, CON3 = 0.05, 1.15, 0.25
JA, BA, SA, GA = float(os.environ.get('JA', '0.2')), float(os.environ.get('BA', '1')), float(os.environ.get('SA', '0.95')), float(os.environ.get('GA', '0.8'))  # «apple»
ENC = os.environ.get('ENC', '1886')  # codifica d'uscita delle varianti display-referred: 1886 = inversa EOTF BT.1886 (1/2.4), 709 = OETF BT.709
K20 = np.array([0.2627, 0.678, 0.0593]); K709 = np.array([0.2126, 0.7152, 0.0722])
M = np.array([[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]])  # BT.2020 -> BT.709 lineare

def hlgi(e):
    a, b, c = 0.17883277, 0.28466892, 0.55991073; x = np.clip(e, 0, 1)
    return np.where(x <= 0.5, x * x / 3, (np.exp((x - c) / a) + b) / 12)
def display(e):  # inversa HLG + OOTF BT.2100 (gamma di sistema 1.2, picco 1000 nit) -> nit, BT.2020
    sc = hlgi(e); return LW * np.maximum(sc @ K20, 1e-6)[..., None] ** 0.2 * sc
def oetf(v):
    v = np.clip(v, 0, 1); return np.where(v < 0.018, 4.5 * v, 1.099 * v ** 0.45 - 0.099)
def enc(v):  # luce del display -> segnale: BT.1886 inversa (BT.2408/2446: uscita per display γ 2.4) o OETF BT.709
    return np.clip(v, 0, 1) ** (1 / 2.4) if ENC == '1886' else oetf(v)
def inv709(v): return np.where(v < 0.081, v / 4.5, ((v + 0.099) / 1.099) ** (1 / 0.45))
def mx(l): return l.max(-1, keepdims=True)
def gam(l):  # compressione morbida del gamut verso la luminanza (soglia GT; tinta e luminanza invariate)
    y = np.clip(l @ K709, 0, 1)[..., None]; c = l - y
    lim = np.where(c < 0, y / np.maximum(-c, 1e-9), np.where(c > 0, (1 - y) / np.maximum(c, 1e-9), 1e9))
    s = 1 / np.maximum(lim.min(-1, keepdims=True), 1e-9)
    f = np.where(s > GT, (GT + (s - GT) / (1 + (s - GT) / (1 - GT))) / np.maximum(s, 1e-9), 1)
    return np.clip(y + c * f, 0, 1)
def hb(x): return ((x * (0.15 * x + 0.05) + 0.004) / (x * (0.15 * x + 0.5) + 0.06)) - 0.02 / 0.3
def mob(x, j, pk):
    a = -j * j * (pk - 1) / (j * j - 2 * j + pk); b = (j * j - 2 * j * pk + pk) / max(1e-6, pk - 1)
    return np.where(x <= j, x, (b * b + 2 * b * j + j * j) / (b - a) * (x + a) / (x + b))

def t_hable(e):
    l = np.maximum(display(e) @ M.T, 0); sg = np.maximum(mx(l), 1e-6); return oetf(l * (hb(sg / 100) / hb(LW / 100) / sg))
def t_bt2446c(e):
    d = display(e); c = (1 - 3 * XA) * d + XA * d.sum(-1, keepdims=True); Y = np.maximum(c @ K20, 1e-6)[..., None]
    k1, k2, k3, k4 = 0.83802, 15.09968, 0.74204, 78.99439; yip = 58.5 / k1
    ys = np.where(Y < yip, k1 * Y, k2 * np.log(np.maximum(Y / yip - k3, 1e-6)) + k4)
    x = c * (ys / Y); s = (x - XA * x.sum(-1, keepdims=True)) / (1 - 3 * XA); l = s @ M.T / 100
    return enc(gam(l / np.maximum(mx(l), 1)))
def t_bt2408(e):  # mobius su max-RGB, 203 nit = 100 %
    d = display(e); l = d @ M.T; n = np.maximum(np.maximum(mx(l), (d @ K20)[..., None]), 1e-6)
    return enc(gam(l * (mob(n / REF, J, LW / REF) / n)))
def t_apple(e):  # «Apple-like»: norma ibrida luma/max-RGB (BA), mobius morbido (JA), saturazione SA, BT.1886
    d = display(e); l = d @ M.T; Y = np.maximum(d @ K20, 1e-6)[..., None]; n = np.maximum((1 - BA) * Y + BA * np.maximum(mx(l), Y), 1e-6)
    t = l * (mob(GA * n / REF, JA, GA * LW / REF) / n); y = (t @ K709)[..., None]; return enc(gam(y + (t - y) * SA))
def t_hlgsdr(e):
    l = np.clip(e, 0, 1) ** 2.4 @ M.T; y = np.clip(l @ K709, 1e-6, 1)[..., None]; ls = y + (l - y) * SAT3
    ye = oetf(y); y2 = inv709(ye + (ye * ye * (3 - 2 * ye) - ye) * CON3); return enc(gam(ls * (y2 / y)))
def r_iphone(e):
    l = display(e) @ M.T / REF; y = np.clip(l @ K709, 0, None)[..., None]; return oetf(gam(l * np.minimum(1, 1 / np.maximum(y, 1e-6))))
VARIANTS = dict(hable=t_hable, bt2446c=t_bt2446c, bt2408=t_bt2408, apple=t_apple, hlgsdr=t_hlgsdr)

def ff_frame(src, n, vf, tmp):
    out = os.path.join(tmp, 'f.yuv')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-noautorotate', '-i', src, '-vf', f'select=eq(n\\,{n})' + (',' + vf if vf else ''),
                    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', out], check=True)
    return np.fromfile(out, dtype='<u2')
def planes(a, w, h):
    up = lambda c: c.reshape(h // 2, w // 2).repeat(2, 0).repeat(2, 1).astype(np.float64)
    return a[:w * h].reshape(h, w).astype(np.float64), up(a[w * h:w * h * 5 // 4]), up(a[w * h * 5 // 4:])
def ycc(rgb):
    y = rgb @ K709; return 16 + 219 * y, 128 + 224 * (rgb[..., 2] - y) / 1.8556, 128 + 224 * (rgb[..., 0] - y) / 1.5748

def main():
    for src in sys.argv[1:]:
        q = lambda k: subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', k, '-of', 'csv=p=0', src], capture_output=True, text=True).stdout
        w, h = (int(x) for x in q('stream=width,height').split(',')[:2])
        nf = int(''.join(ch for ch in subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', src], capture_output=True, text=True).stdout if ch.isdigit()))
        with tempfile.TemporaryDirectory() as tmp:
            y, u, v = planes(np.round(ff_frame(src, nf // 2, '', tmp) / 4), w, h)  # 8 bit come VideoDecoder
            Y, Cb, Cr = (y - 16) / 219, (u - 128) / 224, (v - 128) / 224
            R = Y + 1.4746 * Cr; B = Y + 1.8814 * Cb; e = np.stack([R, (Y - 0.2627 * R - 0.0593 * B) / 0.678, B], -1)
            refs = {'iphone': ycc(r_iphone(e))}
            for npl in (100, 203):
                vf = (f'zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=tv:t=linear:npl={npl},format=gbrpf32le,zscale=p=bt709,'
                      f'tonemap=mobius:desat=0:peak={LW / npl},zscale=t=bt709:p=bt709:m=bt709:r=tv')
                refs[f'mob{npl}'] = tuple(p / 4 for p in planes(ff_frame(src, nf // 2, vf, tmp), w, h))
        Yd = display(e) @ K20; lo, hi, sh = Yd < REF, Yd > REF, Yd < 5
        yi, ui, vi = refs['iphone']; Ci = np.hypot(ui - 128, vi - 128); ang = np.degrees(np.arctan2(vi - 128, ui - 128))
        pp = (Ci > 8) & (ang > 20) & (ang < 120); ym, um, vm = refs['mob203']; Cm = np.hypot(um - 128, vm - 128)
        print(f'\n== {os.path.basename(src)} frame {nf // 2}: sopra 203 nit {hi.mean() * 100:.0f}%, rosa/viola {pp.mean() * 100:.1f}%  (J={J} JA={JA} BA={BA} SA={SA} ENC={ENC})')
        print(f"{'':9}{'Ymean':>7}{'Ystd':>6}{'sat':>6}{'satPP':>6}{'clip%':>6}{'dark%':>6}{'hiStd':>6}{'shStd':>6}  dY/dC iphone  dY/dC mob203")
        rows = list(refs.items()) + [(k, ycc(f(e))) for k, f in VARIANTS.items()]
        for k, (y, u, v) in rows:
            C = np.hypot(u - 128, v - 128)
            print(f'{k:9}{y.mean():7.1f}{y.std():6.1f}{C.mean():6.1f}{C[pp].mean():6.1f}{(y >= 233).mean() * 100:6.1f}{(y <= 24).mean() * 100:6.1f}'
                  f'{y[hi].std():6.1f}{y[sh].std():6.1f}  {np.abs(y - yi)[lo].mean():5.1f}/{np.abs(C - Ci)[lo].mean():4.1f}   {np.abs(y - ym).mean():5.1f}/{np.abs(C - Cm).mean():4.1f}')

if __name__ == '__main__':
    main()
