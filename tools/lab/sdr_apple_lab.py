#!/usr/bin/env python3
"""Quanto ogni via HLG -> SDR si avvicina alla conversione «compatibile» di Apple (Foto / Esporta), su tutti i frame della clip.

Uso: python3 -I tools/lab/sdr_apple_lab.py HDR.mov APPLE_SDR.mov [candidato.mp4 ...] [--lut vendor/lut/apple_hlg_sdr33.bin]
  HDR = originale HLG (BT.2020, arib-std-b67), APPLE_SDR = stessa clip esportata «compatibile» da Apple (BT.709): stessi pts.
  candidato = MP4 SDR prodotto altrove (es. b_sys_8M.mp4 di tools/diag/sdr8.html su iPhone), confrontato frame per frame.
  --lut FILE = adatta una 3D LUT 33³ (HLG R'G'B' -> SDR R'G'B' BT.709, uint16 LE, ordine r veloce, poi g, poi b) e la scrive.
Misure a mezza risoluzione (luma media 2×2, croma 4:2:0 nativa), decodifica uguale per tutti (BT.709 limitato, γ 2.4, D65):
  ΔE2000 medio / p95 contro Apple, scarto di luma (codici 8 bit), C*ab medio rispetto ad Apple (saturazione),
  curva luma: mediana dell'uscita per classe di luma HLG d'ingresso, e quanto varia tra i frame (adattiva per scena?).
Le varianti nostre usano la matematica dello shader (tools/lab/sdr8_tm_metrics.py) su ingresso 8 bit come VideoDecoder.
"""
import importlib.util, os, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location('tm', os.path.join(HERE, 'sdr8_tm_metrics.py')); TM = importlib.util.module_from_spec(_s); _s.loader.exec_module(TM)
N = 33

def probe(src, k):
    return subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', k, '-of', 'csv=p=0', src], capture_output=True, text=True).stdout.strip()
def frames(src, n, deep):
    w, h = (int(x) for x in probe(src, 'stream=width,height').split(',')[:2])
    fmt, dt, sz = ('yuv420p10le', '<u2', 2) if deep else ('yuv420p', 'u1', 1)
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-noautorotate', '-i', src, '-frames:v', str(n), '-f', 'rawvideo', '-pix_fmt', fmt, '-'], stdout=subprocess.PIPE)
    fs = w * h * 3 // 2
    while True:
        b = p.stdout.read(fs * sz)
        if len(b) < fs * sz: break
        a = np.frombuffer(b, dt).astype(np.float32) / (4 if deep else 1)  # codici in scala 8 bit (10 bit: frazionari)
        y = a[:w * h].reshape(h // 2, 2, w // 2, 2).mean((1, 3)); u = a[w * h:w * h * 5 // 4].reshape(h // 2, w // 2); v = a[w * h * 5 // 4:].reshape(h // 2, w // 2)
        yield y, u, v
    p.wait()

def hlg_rgb(y, u, v):  # BT.2020 NCL limitato -> R'G'B' HLG
    Y, Cb, Cr = (y - 16) / 219, (u - 128) / 224, (v - 128) / 224
    R = Y + 1.4746 * Cr; B = Y + 1.8814 * Cb; return np.stack([R, (Y - 0.2627 * R - 0.0593 * B) / 0.678, B], -1)
def sdr_rgb(y, u, v):  # BT.709 limitato -> R'G'B'
    Y, Cb, Cr = (y - 16) / 219, (u - 128) / 224, (v - 128) / 224
    R = Y + 1.5748 * Cr; B = Y + 1.8556 * Cb; return np.stack([R, (Y - 0.2126 * R - 0.0722 * B) / 0.7152, B], -1)
def q8(rgb):  # come lo shader: R'G'B' -> codici NV12 8 bit arrotondati -> R'G'B'
    y, u, v = TM.ycc(np.clip(rgb, 0, 1)); return sdr_rgb(np.round(y), np.round(u), np.round(v))
M709 = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]); WP = np.array([0.95047, 1.0, 1.08883])
def lab(rgb):
    xyz = np.clip(rgb, 0, 1) ** 2.4 @ M709.T / WP; f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)
def de2000(a, b):
    L1, a1, b1 = a[..., 0], a[..., 1], a[..., 2]; L2, a2, b2 = b[..., 0], b[..., 1], b[..., 2]
    C7 = ((np.hypot(a1, b1) + np.hypot(a2, b2)) / 2) ** 7; G = 0.5 * (1 - np.sqrt(C7 / (C7 + 25 ** 7)))
    a1, a2 = a1 * (1 + G), a2 * (1 + G); C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    h1, h2 = np.degrees(np.arctan2(b1, a1)) % 360, np.degrees(np.arctan2(b2, a2)) % 360
    dL, dC = L2 - L1, C2 - C1; dh = h2 - h1; dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh)); dh = np.where(C1 * C2 == 0, 0, dh)
    dH = 2 * np.sqrt(C1 * C2) * np.sin(np.radians(dh / 2)); Lm, Cm = (L1 + L2) / 2, (C1 + C2) / 2
    hs = h1 + h2; hm = np.where(C1 * C2 == 0, hs, np.where(np.abs(h1 - h2) <= 180, hs / 2, np.where(hs < 360, (hs + 360) / 2, (hs - 360) / 2)))
    T = 1 - 0.17 * np.cos(np.radians(hm - 30)) + 0.24 * np.cos(np.radians(2 * hm)) + 0.32 * np.cos(np.radians(3 * hm + 6)) - 0.2 * np.cos(np.radians(4 * hm - 63))
    SL = 1 + 0.015 * (Lm - 50) ** 2 / np.sqrt(20 + (Lm - 50) ** 2); SC = 1 + 0.045 * Cm; SH = 1 + 0.015 * Cm * T
    C7 = Cm ** 7; RT = -2 * np.sqrt(C7 / (C7 + 25 ** 7)) * np.sin(np.radians(60 * np.exp(-((hm - 275) / 25) ** 2)))
    return np.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH))

# ---- 3D LUT 33³: applicazione trilineare e adattamento (splat iterativo ai nodi ≈ minimi quadrati, nodi vuoti = prior hable, la curva nostra più vicina) ----
def corners(x):
    p = np.clip(x, 0, 1) * (N - 1); i = np.minimum(p.astype(np.int64), N - 2); f = p - i
    for c in range(8):
        o = np.array([c & 1, (c >> 1) & 1, (c >> 2) & 1]); w = np.prod(np.where(o, f, 1 - f), -1)
        j = i + o; yield (j[:, 0] + N * j[:, 1] + N * N * j[:, 2]), w
def lut_apply(L, x):
    out = np.zeros((len(x), 3), np.float64)
    for k, w in corners(x): out += L[k] * w[:, None]
    return out
def lut_fit(xs, ys, it=30):
    g = np.linspace(0, 1, N); gb, gg, gr = np.meshgrid(g, g, g, indexing='ij'); node = np.stack([gr, gg, gb], -1).reshape(-1, 3)
    L = TM.t_hable(node); den = np.zeros(N ** 3)
    for k, w in corners(xs): den += np.bincount(k, w, N ** 3)
    for _ in range(it):
        r = ys - lut_apply(L, xs); num = np.zeros((N ** 3, 3))
        for k, w in corners(xs):
            for c in range(3): num[:, c] += np.bincount(k, w * r[:, c], N ** 3)
        L += num / (den + 2.0)[:, None]
    return np.clip(L, 0, 1)

def main():
    a = [x for x in sys.argv[1:] if not x.startswith('--')]; lutp = sys.argv[sys.argv.index('--lut') + 1] if '--lut' in sys.argv else None
    if lutp: a.remove(lutp)
    hdr, ref, cands = a[0], a[1], a[2:]
    n = min(int(probe(x, 'stream=nb_frames').split(',')[0] or 1e9) for x in a[:2])
    names = list(TM.VARIANTS) + [os.path.basename(c) for c in cands] + (['lut(pari→dispari)', 'lut(1ª→2ª metà)'] if lutp else [])
    gens = [frames(c, n, False) for c in cands]
    st = {k: dict(de=[], dy=[], C=[]) for k in names}; Cref, curve = [], {k: [] for k in ['apple'] + list(TM.VARIANTS)}
    keep = []; BINS = np.linspace(0, 1, 17)
    for fi, ((hy, hu, hv), (sy, su, sv)) in enumerate(zip(frames(hdr, n, True), frames(ref, n, False))):
        e10 = hlg_rgb(hy, hu, hv); e8 = hlg_rgb(np.round(hy), np.round(hu), np.round(hv))  # 8 bit come VideoDecoder
        rr = np.clip(sdr_rgb(sy, su, sv), 0, 1); lr = lab(rr); Cref.append(np.hypot(lr[..., 1], lr[..., 2]).mean())
        yin = np.clip((hy - 16) / 219, 0, 1); b = np.digitize(yin, BINS) - 1
        med = lambda yo: [np.median(yo[b == i]) if (b == i).sum() > 200 else np.nan for i in range(16)]
        curve['apple'].append(med(sy))
        outs = {k: q8(f(e8)) for k, f in TM.VARIANTS.items()}
        for k in TM.VARIANTS: curve[k].append(med(TM.ycc(np.clip(outs[k], 0, 1))[0]))
        for c, g in zip(cands, gens):
            cy, cu, cv = next(g); outs[os.path.basename(c)] = sdr_rgb(cy, cu, cv)
        for k, o in outs.items():
            lo = lab(np.clip(o, 0, 1)); st[k]['de'].append(de2000(lr, lo).astype(np.float32).ravel())
            st[k]['dy'].append(np.abs(TM.ycc(np.clip(o, 0, 1))[0] - sy).mean()); st[k]['C'].append(np.hypot(lo[..., 1], lo[..., 2]).mean())
        if lutp: keep.append((e10[::2, ::2].reshape(-1, 3), rr[::2, ::2].reshape(-1, 3), e8[1::2, 1::2].reshape(-1, 3), rr[1::2, 1::2].reshape(-1, 3), lr[1::2, 1::2].reshape(-1, 3)))
    nf = fi + 1
    if lutp:  # validazione: adatta su una parte, misura sull'altra (frame dispari / seconda metà), poi LUT finale su tutto
        def held(tr, te, key):
            L = lut_fit(np.concatenate([keep[i][0] for i in tr]), np.concatenate([keep[i][1] for i in tr]))
            for i in te:
                o = q8(lut_apply(L, keep[i][2])); lo = lab(o); st[key]['de'].append(de2000(keep[i][4], lo).astype(np.float32))
                st[key]['dy'].append(np.abs(TM.ycc(o)[0] - TM.ycc(keep[i][3])[0]).mean()); st[key]['C'].append(np.hypot(lo[..., 1], lo[..., 2]).mean())
            return L
        held(range(0, nf, 2), range(1, nf, 2), 'lut(pari→dispari)'); held(range(nf // 2), range(nf // 2, nf), 'lut(1ª→2ª metà)')
        L = lut_fit(np.concatenate([k[0] for k in keep]), np.concatenate([k[1] for k in keep]))
        os.makedirs(os.path.dirname(lutp) or '.', exist_ok=True); np.round(L * 65535).astype('<u2').tofile(lutp)
        print(f'LUT {N}³ scritta: {lutp} ({os.path.getsize(lutp) // 1024} KB, uint16 LE, r veloce)')
    cr = np.mean(Cref)
    print(f'\n== {nf} frame allineati per indice (pts uguali), mezza risoluzione; C*ab medio Apple {cr:.1f}')
    print(f"{'via':22}{'ΔE00 med':>9}{'p95':>7}{'|ΔY| 8b':>9}{'C*/Apple':>9}")
    for k in names:
        if not st[k]['de']: continue
        d = np.concatenate(st[k]['de']); print(f"{k:22}{d.mean():9.2f}{np.percentile(d, 95):7.2f}{np.mean(st[k]['dy']):9.2f}{np.mean(st[k]['C']) / cr:9.3f}")
    print('\nCurva luma: mediana di Y\' 8 bit d\'uscita per classe di Y\' HLG d\'ingresso (0–1); «±» = escursione tra i frame della mediana Apple')
    cv = {k: np.array(v, float) for k, v in curve.items()}
    print(f"{'Y HLG':>6}" + ''.join(f'{k:>9}' for k in cv) + f"{'±apple':>8}")
    for i in range(16):
        if np.isnan(cv['apple'][:, i]).all(): continue
        print(f'{(BINS[i] + BINS[i + 1]) / 2:6.2f}' + ''.join(f'{np.nanmedian(cv[k][:, i]):9.1f}' for k in cv) + f'{np.nanmax(cv["apple"][:, i]) - np.nanmin(cv["apple"][:, i]):8.1f}')

if __name__ == '__main__':
    main()
