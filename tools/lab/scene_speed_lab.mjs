#!/usr/bin/env node
// Laboratorio v0.35 «qualità per scena più veloce» (docs/research/12 §12): la metrica più economica regge?
// Confronta, contro il VMAF vero (vmaf_v0.6.1, come tools/lab/vmaf_score.sh), la stima della app con varianti di
//   finestra di prova (1.0 / 0.5 s), stride (1 frame su 2/3/4) e risoluzione della luma (½ = 540×960, ¼ = 270×480;
//   a ¼ sia filtro box sia «bilineare» = media dei 2×2 pixel centrali di ogni blocco 4×4, come drawImage senza mipmap).
// Per ogni variante: taratura lineare VMAF ≈ a + b·media(ssimDb) sulle finestre, poi
//   (A) stima della FINESTRA vs VMAF della finestra (ciò che misura la taratura)        → PLCC, RMSE, RMSE leave-one-clip-out
//   (B) stima dalla finestra CENTRATA vs VMAF dell'intero segmento d'export (4 s)      → PLCC, RMSE (ciò che conta per l'app)
//   (C) errore sul bitrate necessario per VMAF 88 (log2, segmento intero) scegliendo con la stima + 1 s.d.
// Dati: ogni clip = originale + uscite a più bitrate. IMG_7440: uscite REALI dell'app (VideoToolbox, v0.13) se presenti;
// gli altri clip: x265 «simil-VT» (veryfast, niente B-frame, ABR) generati qui. I file privati sono solo LETTI; tutto ciò che
// si genera sta in $LAB (default /tmp/claude-0/lab/speed), mai nel repo.
//
// Uso: TMPDIR=/tmp/claude-0/lab/tmp node tools/lab/scene_speed_lab.mjs [--clips a.mov,b.mov] [--rates 2,3.5,6,10]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lumaFromPlane, ssim, toDb, DEFAULT_CALIBRATION } from '../../app/lib/quality.js';
import { planSceneSegments, runSceneSearch } from '../../app/lib/scenesearch.js';
import { planSegments as jobSegments } from '../../app/lib/jobstore.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LAB = process.env.LAB || '/tmp/claude-0/lab/speed';
const VMAF = process.env.VMAF || '/tmp/claude-0/lab/vmaf-src/libvmaf/build/tools/vmaf';
const MODELS = process.env.MODELS || '/tmp/claude-0/lab/vmaf-src/model';
const PRIV = process.env.PRIV_DIR || '/root/.claude/uploads/41829d04-493e-5956-8e38-1bd70ab69d5c';
const VT_CACHE = process.env.VT_CACHE || '/tmp/claude-0/lab/calib'; // VMAF per-frame già calcolato da calibrate_quality.mjs
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RATES = arg('--rates', '2,3.5,6,10').split(',').map(Number);
mkdirSync(LAB, { recursive: true });

// ---------- clip ----------
const clips = [];
const vtDir = PRIV; const vt7440 = existsSync(vtDir) ? readdirSync(vtDir).map((f) => ({ f, m: f.match(/IMG_7440_(\d+)M_k4s_aCopy_v0\.13$/) })).filter((x) => x.m) : [];
if (vt7440.length >= 3 && existsSync(join(ROOT, 'samples/IMG_7440.mov'))) clips.push({ name: 'IMG_7440-VT', ref: join(ROOT, 'samples/IMG_7440.mov'), enc: 'vt',
  dists: vt7440.map((x) => ({ path: join(vtDir, x.f), mbps: +x.m[1], vmafCache: join(VT_CACHE, `vmaf_IMG_7440_${x.m[1]}M_v0.13.json`) })).sort((a, b) => a.mbps - b.mbps) });
const extra = arg('--clips', '') ? arg('--clips').split(',') : [join(ROOT, 'samples/IMG_2147.mov'), join(ROOT, 'samples/IMG_7440.mov'),
  ...(existsSync(PRIV) ? readdirSync(PRIV).filter((f) => /\.mov$/.test(f)).map((f) => join(PRIV, f)) : [])];
const seen = new Set();
for (const ref of extra) {
  if (!existsSync(ref)) continue;
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', ref]).toString().trim().split('\n')[0].split(',').map(Number);
  if (Math.max(w, h) > 1920) continue; // 4K: stesso contenuto della versione 1080p (dove c'è); la app misura comunque a encW×encH
  const name = basename(ref).replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{8}-/, '') + '-x265p';
  if (seen.has(name)) continue; seen.add(name);
  clips.push({ name, ref, enc: 'x265', dists: RATES.map((mbps) => ({ path: join(LAB, `${name}_${mbps}M.mp4`), mbps })) });
}

if (arg('--only', '')) { const re = new RegExp(arg('--only')); for (let i = clips.length - 1; i >= 0; i--) if (!re.test(clips[i].name)) clips.splice(i, 1); }

// ---------- helpers ----------
const sh = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
function dims(f) { const [w, h] = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim().split('\n')[0].split(',').map(Number); return { w, h }; }
function encodeX265(ref, out, mbps) {
  if (existsSync(out)) return;
  // «simil-VT»: realtime-ish, niente B-frame (VT realtime non li usa), ABR al bitrate chiesto, keyframe ogni 4 s
  sh('ffmpeg', ['-v', 'error', '-y', '-i', ref, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-c:v', 'libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p10le',
    '-b:v', `${mbps}M`, '-x265-params', `bframes=0:keyint=240:rc-lookahead=10:log-level=error`, out]);
}
function vmafFrames(ref, d, W, H) {
  const out = d.vmafCache && existsSync(d.vmafCache) ? d.vmafCache : join(LAB, basename(d.path) + '.vmaf.json');
  if (!existsSync(out)) {
    const r = join(LAB, 'ref.y4m'), x = join(LAB, 'dist.y4m');
    sh('ffmpeg', ['-v', 'error', '-y', '-i', ref, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-vf', `scale=${W}:${H}:flags=bicubic`, '-strict', '-1', '-pix_fmt', 'yuv420p10le', r]);
    sh('ffmpeg', ['-v', 'error', '-y', '-i', d.path, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-strict', '-1', '-pix_fmt', 'yuv420p10le', x]);
    sh(VMAF, ['-r', r, '-d', x, '--threads', '4', '--quiet', '--model', `path=${MODELS}/vmaf_v0.6.1.json:name=vmaf`, '--json', '-o', out]);
  }
  return JSON.parse(readFileSync(out, 'utf8')).frames.map((f) => f.metrics.vmaf);
}
class Reader { // frame gray10le a dimensione fissa da ffmpeg (ref scalato alle dimensioni dell'uscita, come vmaf_score.sh)
  constructor(file, w, h, scale = false) {
    this.size = w * h * 2; this.chunks = []; this.len = 0; this.waiter = null; this.ended = false;
    this.p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', ...(scale ? ['-vf', `scale=${w}:${h}:flags=bicubic`] : []), '-f', 'rawvideo', '-pix_fmt', 'gray10le', '-']);
    this.p.stdout.on('data', (c) => { this.chunks.push(c); this.len += c.length; if (this.len >= this.size * 4) this.p.stdout.pause(); this.waiter?.(); });
    this.p.stdout.on('end', () => { this.ended = true; this.waiter?.(); });
  }
  async next() {
    while (this.len < this.size && !this.ended) await new Promise((r) => { this.waiter = r; this.p.stdout.resume(); });
    if (this.len < this.size) return null;
    const buf = Buffer.concat(this.chunks); this.chunks = [buf.subarray(this.size)]; this.len -= this.size;
    if (this.len < this.size * 4) this.p.stdout.resume();
    return new Uint16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + this.size));
  }
}
// ¼ «bilineare»: drawImage senza mipmap campiona al centro di ogni blocco 4×4 → media dei 2×2 pixel centrali
function centre4(plane, W, H) {
  const w = W >> 2, h = H >> 2, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (4 * y + 1) * W + 4 * x + 1;
    out[y * w + x] = (((plane[p] + 2) >> 2) + ((plane[p + 1] + 2) >> 2) + ((plane[p + W] + 2) >> 2) + ((plane[p + W + 1] + 2) >> 2)) * 0.25;
  }
  return { data: out, width: w, height: h };
}
const VARS = ['f2', 'f4', 'f4c'];
async function perFrame(clip, W, H) {
  const cf = join(LAB, `${clip.name}.ssim.json`);
  if (existsSync(cf)) return JSON.parse(readFileSync(cf, 'utf8'));
  const rr = new Reader(clip.ref, W, H, true), dr = clip.dists.map((d) => new Reader(d.path, W, H));
  const res = clip.dists.map(() => Object.fromEntries(VARS.map((v) => [v, []])));
  for (let n = 0; ; n++) {
    const R = await rr.next(); if (!R) break;
    const Ds = await Promise.all(dr.map((r) => r.next())); if (Ds.some((d) => !d)) break;
    const r2 = lumaFromPlane(R, W, H, W, { factor: 2, bitDepth: 10 }), r4 = lumaFromPlane(R, W, H, W, { factor: 4, bitDepth: 10 }), r4c = centre4(R, W, H);
    Ds.forEach((D, k) => {
      const d2 = lumaFromPlane(D, W, H, W, { factor: 2, bitDepth: 10 }), d4 = lumaFromPlane(D, W, H, W, { factor: 4, bitDepth: 10 }), d4c = centre4(D, W, H);
      res[k].f2.push(toDb(ssim(r2.data, d2.data, r2.width, r2.height).ssim));
      res[k].f4.push(toDb(ssim(r4.data, d4.data, r4.width, r4.height).ssim));
      res[k].f4c.push(toDb(ssim(r4c.data, d4c.data, r4c.width, r4c.height).ssim));
    });
    if (n % 100 === 0) process.stderr.write(`${clip.name} frame ${n}\n`);
  }
  writeFileSync(cf, JSON.stringify(res));
  return res;
}
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
function pearson(x, y) { const n = x.length, mx = mean(x), my = mean(y); let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sx * sy); }
function linfit(x, y) { const n = x.length, mx = mean(x), my = mean(y); let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; } const b = sxy / sxx, a = my - b * mx; return { a, b, sd: Math.sqrt(y.reduce((s, v, i) => s + (v - a - b * x[i]) ** 2, 0) / (n - 2)) }; }
const pctl = (v, q) => { const t = [...v].sort((a, b) => a - b), p = (t.length - 1) * q, i = Math.floor(p); return i + 1 < t.length ? t[i] + (t[i + 1] - t[i]) * (p - i) : t[i]; };
const rmse = (e) => Math.sqrt(mean(e.map((x) => x * x)));

// ---------- dati ----------
const data = [];
for (const clip of clips) {
  if (clip.enc === 'x265') for (const d of clip.dists) encodeX265(clip.ref, d.path, d.mbps);
  const { w: DW, h: DH } = dims(clip.dists[0].path);
  const vm = clip.dists.map((d) => vmafFrames(clip.ref, d, DW, DH));
  const pf = await perFrame(clip, DW, DH);
  const N = Math.min(...vm.map((v) => v.length), ...pf.map((p) => p.f2.length));
  const nf = +sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', clip.dists[0].path]).toString().trim().split('\n')[0].replace(/,/g, '').split('/').reduce((a, b) => a / b);
  const bits = clip.dists.map((d) => { const s = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', d.path], { maxBuffer: 1 << 26 }).toString().trim().split('\n').map((l) => parseInt(l, 10)).filter(Number.isFinite); return s; });
  // pacchetti della sorgente (ordine di presentazione, pts ≥ 0): prior 0.4 × bitrate sorgente della finestra, come la app
  const srcPk = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,size', '-of', 'csv=p=0', clip.ref], { maxBuffer: 1 << 26 }).toString().trim().split('\n')
    .map((l) => l.split(',')).map(([t, z]) => ({ t: +t, size: parseInt(z, 10) })).filter((x) => x.t >= 0 && Number.isFinite(x.size)).sort((a, b) => a.t - b.t);
  data.push({ clip, N, fps: nf, vm, pf, bits, W: DW, H: DH, srcPk });
  console.log(`${clip.name}: ${N} frame ${DW}×${DH} @${nf.toFixed(2)} fps, uscite ${clip.dists.map((d) => d.mbps + 'M').join(' ')}, VMAF medio ${vm.map((v) => mean(v.slice(0, N)).toFixed(1)).join('/')}`);
}

// ---------- analisi ----------
// segmenti d'export: 4 s (jobstore: keyframe 4 s → segmenti da 240 frame); per clip corti il segmento = clip intero.
// Per avere più campioni: segmenti da 4 s che partono ogni 1 s (correlati, ma la stessa regola vale per tutte le varianti).
const CONFIGS = [
  { win: 1.0, stride: 2, v: 'f2', label: 'oggi: 1 s, stride 2, ½' },
  { win: 1.0, stride: 1, v: 'f2', label: '1 s, stride 1, ½' },
  { win: 1.0, stride: 3, v: 'f2', label: '1 s, stride 3, ½' },
  { win: 1.0, stride: 4, v: 'f2', label: '1 s, stride 4, ½' },
  { win: 0.5, stride: 2, v: 'f2', label: '0.5 s, stride 2, ½' },
  { win: 0.5, stride: 3, v: 'f2', label: '0.5 s, stride 3, ½' },
  { win: 1.0, stride: 2, v: 'f4', label: '1 s, stride 2, ¼ box' },
  { win: 1.0, stride: 2, v: 'f4c', label: '1 s, stride 2, ¼ bilin.' },
  { win: 1.0, stride: 3, v: 'f4c', label: '1 s, stride 3, ¼ bilin.' },
  { win: 0.5, stride: 3, v: 'f4c', label: '0.5 s, stride 3, ¼ bilin.' },
  { win: 0.5, stride: 4, v: 'f4c', label: '0.5 s, stride 4, ¼ bilin.' },
];
const SEGS = 4.0, STEP = 1.0, TARGET = 88;
// La taratura è lineare e serve solo vicino alla soglia: finestre con VMAF fuori da [65, 97] (contenuto saturo/statico
// o rovinato) sono escluse dalla taratura e dalle statistiche (A), come nella taratura originale (IMG_7440: 76–95).
const IN_RANGE = (y) => y >= 65 && y <= 97;
function samples(cfg) {
  const win = [], seg = [];
  for (const D of data) {
    const wl = Math.max(4, Math.round(cfg.win * D.fps)), sl = Math.min(D.N, Math.round(SEGS * D.fps));
    // (A) finestre contigue non sovrapposte
    for (let a = 0; a + wl <= D.N; a += wl) D.clip.dists.forEach((_, k) => {
      const xs = []; for (let i = a; i < a + wl; i += cfg.stride) xs.push(D.pf[k][cfg.v][i]);
      const y = mean(D.vm[k].slice(a, a + wl));
      if (IN_RANGE(y)) win.push({ clip: D.clip.name, x: mean(xs), y, xl: pctl(xs, 0.05), yl: pctl(D.vm[k].slice(a, a + wl), 0.05) });
    });
    // (B/C) segmenti d'export con finestra centrata
    for (let s = 0; s + sl <= D.N; s += Math.max(1, Math.round(STEP * D.fps))) {
      const c0 = s + Math.round((sl - wl) / 2);
      const pts = D.clip.dists.map((_, k) => {
        const xs = []; for (let i = c0; i < c0 + wl; i += cfg.stride) xs.push(D.pf[k][cfg.v][i]);
        const segBits = D.bits[k].slice(s, s + sl).reduce((a, b) => a + b, 0) * 8 / (sl / D.fps);
        return { x: mean(xs), y: mean(D.vm[k].slice(s, s + sl)), rate: segBits };
      });
      seg.push({ clip: D.clip.name, pts });
      if (sl >= D.N) break;
    }
  }
  return { win, seg };
}
const interpRate = (pts, key, t) => { // rate (log) dove key raggiunge t; NaN se fuori dalla scala
  const p = [...pts].sort((a, b) => a.rate - b.rate);
  for (let i = 0; i + 1 < p.length; i++) if ((p[i][key] - t) * (p[i + 1][key] - t) <= 0 && p[i][key] !== p[i + 1][key]) { const u = (t - p[i][key]) / (p[i + 1][key] - p[i][key]); return Math.exp(Math.log(p[i].rate) + u * (Math.log(p[i + 1].rate) - Math.log(p[i].rate))); }
  return NaN;
};
console.log(`\nsegmenti d'export ${SEGS} s (ogni ${STEP} s), soglia VMAF ${TARGET}; taratura per variante sulle finestre (A)`);
console.log(`finestre in taratura (VMAF 65–97): ${samples(CONFIGS[0]).win.length}`);
console.log('variante                    | (A) finestra: PLCC  RMSE  RMSE-LOCO | (B) segmento: PLCC  RMSE  bias | (C) bitrate: rmse log2  sottostima>10%  n');
const out = [];
for (const cfg of CONFIGS) {
  const { win, seg } = samples(cfg);
  const f = linfit(win.map((s) => s.x), win.map((s) => s.y));
  const loco = []; for (const c of new Set(win.map((s) => s.clip))) { const tr = win.filter((s) => s.clip !== c), te = win.filter((s) => s.clip === c); if (new Set(tr.map((s) => s.clip)).size < 1 || !te.length) continue; const g = linfit(tr.map((s) => s.x), tr.map((s) => s.y)); te.forEach((s) => loco.push(g.a + g.b * s.x - s.y)); }
  const sx = [], sy = [], er = []; let under = 0, nC = 0;
  for (const s of seg) {
    for (const p of s.pts) { if (!IN_RANGE(p.y)) continue; const e = f.a + f.b * p.x; sx.push(e); sy.push(p.y); }
    const pts = s.pts.map((p) => ({ rate: p.rate, est: f.a + f.b * p.x, y: p.y }));
    const need = interpRate(pts, 'y', TARGET), pick = interpRate(pts, 'est', TARGET + f.sd);
    if (Number.isFinite(need) && Number.isFinite(pick)) { er.push(Math.log2(pick / need)); nC++; if (pick < need / 1.1) under++; }
  }
  const rB = rmse(sx.map((x, i) => x - sy[i])), bias = mean(sx.map((x, i) => x - sy[i]));
  out.push({ label: cfg.label, cfg, fit: f, plccA: pearson(win.map((s) => s.x), win.map((s) => s.y)), rmseA: f.sd, locoA: rmse(loco), plccB: pearson(sx, sy), rmseB: rB, bias, rC: rmse(er), meanC: er.length ? mean(er) : NaN, under, nC });
  const o = out[out.length - 1];
  console.log(`${cfg.label.padEnd(27)} |        ${o.plccA.toFixed(3)}  ${o.rmseA.toFixed(2)}  ${o.locoA.toFixed(2)}     |        ${o.plccB.toFixed(3)}  ${o.rmseB.toFixed(2)}  ${o.bias.toFixed(2).padStart(5)} |  ${o.rC.toFixed(3)} (media ${o.meanC.toFixed(3)})  ${o.under}/${o.nC}  fit a=${f.a.toFixed(2)} b=${f.b.toFixed(3)}`);
}
// per clip (variante di oggi vs ¼): la taratura generale regge clip per clip?
console.log('\nRMSE (A) per clip con la taratura di tutti i clip:');
for (const cfg of [CONFIGS[0], CONFIGS[7], CONFIGS[8]]) {
  const { win } = samples(cfg); const f = linfit(win.map((s) => s.x), win.map((s) => s.y));
  console.log(`  ${cfg.label.padEnd(27)} ` + [...new Set(win.map((s) => s.clip))].map((c) => { const w = win.filter((s) => s.clip === c); return `${c} ${rmse(w.map((s) => f.a + f.b * s.x - s.y)).toFixed(2)} (bias ${mean(w.map((s) => f.a + f.b * s.x - s.y)).toFixed(2)})`; }).join(' · '));
}
writeFileSync(join(LAB, 'summary.json'), JSON.stringify(out.map(({ fit, ...o }) => ({ ...o, fit: { a: +fit.a.toFixed(3), b: +fit.b.toFixed(4), sd: +fit.sd.toFixed(2) } })), null, 1));

// ---------- simulazione della ricerca (v0.34 vs v0.35) con le uscite reali rigiocate ----------
// encodeTrial(w, r): punto al bitrate r (reale = richiesto); ssimDb per frame interpolati in log-rate fra le uscite reali
// (variante della metrica come in CONFIGS, taratura della variante); VMAF «vero» del SEGMENTO al bitrate scelto: VMAF per
// frame interpolato allo stesso modo su tutto il segmento d'export. Fuori dalla scala delle uscite si estrapola linearmente
// in log-rate dalle due più vicine (approssimazione). Conteggi: encoder, misure, giri.
const lerpRate = (D, series, i, r) => {
  const xs = D.clip.dists.map((d) => Math.log(d.mbps * 1e6)), x = Math.log(r); let j = 0; while (j < xs.length - 2 && x > xs[j + 1]) j++;
  const u = (x - xs[j]) / (xs[j + 1] - xs[j]); return series[j][i] + u * (series[j + 1][i] - series[j][i]);
};
async function simulate(cfg, fitOf, ceiling, fast) {
  const rows = [];
  for (const D of data) {
    const fit = fitOf(D.clip.name); if (!fit) continue;
    const cal = { ...DEFAULT_CALIBRATION, a: fit.a, b: fit.b, sd: fit.sd, aLow: fit.aLow ?? DEFAULT_CALIBRATION.aLow, bLow: fit.bLow ?? DEFAULT_CALIBRATION.bLow, sdLow: fit.sdLow ?? DEFAULT_CALIBRATION.sdLow };
    const fr = Array.from({ length: D.N }, (_, i) => ({ ts: i / D.fps, dur: 1 / D.fps, size: D.srcPk[i]?.size || 0 }));
    const st = jobSegments(D.N, D.fps, Math.round(4 * D.fps));
    const plan = planSceneSegments(fr, st, ceiling, { trialSec: cfg.win });
    const series = D.pf.map((p) => p[cfg.v]);
    let enc = 0, meas = 0, rounds = 0;
    const deps = {
      async encodeTrial(w, rates) { enc += rates.length; return rates.map((r) => ({ bitrate: r, requested: r, bytes: r / 8, encoded: { r } })); },
      async measure(w, e) { meas++; const o = []; for (let i = w.startIdx; i < w.endIdx; i += cfg.stride) o.push(lerpRate(D, series, i, e.r)); return o; },
    };
    const recs = await runSceneSearch({ plan, deps, ceiling, opts: { calibration: cal, fast } });
    recs.forEach((r, k) => { rounds += r.n?.r ?? (r.pts.length > 2 ? 2 : 1);
      const s = plan[k]; let v = 0; for (let i = s.startIdx; i < s.endIdx; i++) v += lerpRate(D, D.vm, i, r.b);
      rows.push({ clip: D.clip.name, b: r.b, dur: s.duration, vTrue: v / (s.endIdx - s.startIdx), why: r.why, est: r.est?.q }); });
    rows.push({ clip: D.clip.name, enc, meas, rounds, cost: true });
  }
  const segs = rows.filter((r) => !r.cost), cost = rows.filter((r) => r.cost);
  const d = segs.reduce((a, r) => a + r.dur, 0);
  return { mean: segs.reduce((a, r) => a + r.b * r.dur, 0) / d, vMin: Math.min(...segs.map((r) => r.vTrue)), under: segs.filter((r) => r.vTrue < 88 && r.why !== 'clamped-max').length,
    capped: segs.filter((r) => r.why === 'clamped-max').length, n: segs.length, enc: cost.reduce((a, r) => a + r.enc, 0), meas: cost.reduce((a, r) => a + r.meas, 0), rounds: segs.length ? cost.reduce((a, r) => a + r.rounds, 0) : 0, segs };
}
console.log('\ntaratura PER CLIP (finestre VMAF 65–97): PLCC / RMSE');
for (const cfg of [CONFIGS[0], CONFIGS[3], CONFIGS[4], CONFIGS[6], CONFIGS[7], CONFIGS[8]]) {
  const { win } = samples(cfg);
  console.log(`  ${cfg.label.padEnd(27)} ` + [...new Set(win.map((x) => x.clip))].map((c) => { const w = win.filter((x) => x.clip === c); if (w.length < 4) return `${c} n=${w.length}`; const g = linfit(w.map((x) => x.x), w.map((x) => x.y)); return `${c} ${pearson(w.map((x) => x.x), w.map((x) => x.y)).toFixed(3)}/${g.sd.toFixed(2)} (n ${w.length})`; }).join(' · '));
}
console.log('\nsimulazione ricerca per segmento d\'export (4 s), punti al bitrate richiesto, VMAF vero interpolato sul segmento intero:');
console.log('(taratura per clip; clip con < 4 finestre in taratura esclusi)');
console.log('variante / limite / politica      | Mbps medi | VMAF vero min (non al limite) | sotto 88 non al limite | al limite | encoder | misure | giri');
for (const cfg of [CONFIGS[0], CONFIGS[4], CONFIGS[7], CONFIGS[9]]) {
  // taratura PER CLIP (la stessa per v0.34 e v0.35): qui si confrontano le politiche, non la generalizzazione della taratura
  const { win } = samples(cfg);
  const fitOf = (name) => { const w = win.filter((x) => x.clip === name); if (w.length < 4) return null; const f0 = linfit(w.map((x) => x.x), w.map((x) => x.y)), fl = linfit(w.map((x) => x.xl), w.map((x) => x.yl)); return { ...f0, aLow: fl.a, bLow: fl.b, sdLow: fl.sd }; };
  const f = fitOf;
  for (const ceiling of [8e6, 12e6]) for (const fast of [false, true]) {
    if (!fast && cfg !== CONFIGS[0]) continue;
    const r = await simulate(cfg, f, ceiling, fast);
    const vNC = r.segs.filter((x) => x.why !== 'clamped-max').map((x) => x.vTrue);
    console.log(`${cfg.label.padEnd(26)} ${String(ceiling / 1e6).padStart(2)} ${fast ? 'v0.35' : 'v0.34'} | ${(r.mean / 1e6).toFixed(2).padStart(6)}    | ${(vNC.length ? Math.min(...vNC) : NaN).toFixed(1).padStart(6)}                        | ${String(r.under).padStart(2)}/${r.n}                  | ${String(r.capped).padStart(2)}       | ${String(r.enc).padStart(4)}    | ${String(r.meas).padStart(4)}   | ${r.rounds}`);
    if (process.env.SIM_DETAIL) for (const x of r.segs) console.log(`    ${x.clip} ${(x.b / 1e6).toFixed(2)} Mbps ${x.why} est ${x.est?.toFixed(1)} vero ${x.vTrue.toFixed(1)}`);
  }
}
