#!/usr/bin/env node
// Calibration of the in-app quality metric (app/lib/quality.js) against VMAF (vmaf_v0.6.1).
// See docs/research/12-ricerca-per-scena.md.
//
// Usage: node tools/lab/calibrate_quality.mjs [--seg 1.0] [--quick]
// Env:
//   CALIB_REF      original .mov            (default samples/IMG_7440.mov)
//   CALIB_DIST     dir with real app outputs named *-<base>_<N>M_k4s_aCopy_v0.13 (default: the session uploads dir)
//   CALIB_TAG      version tag of the outputs (default v0.13)
//   VMAF, MODELS   libvmaf CLI and model dir (as tools/lab/vmaf_score.sh)
//   CALIB_CACHE    cache dir for per-frame VMAF json (default $TMPDIR/calib)
// Private data is only READ from those paths; nothing is copied into the repo.
// Exits 0 with a message if the files are missing.
//
// Decoding choice (mirrors the browser path): ffmpeg decodes both files to the 10-bit luma plane
// (gray10le, limited range, no colour conversion, autorotated); quality.js turns it into 8-bit with
// round(Y10/4) — what Safari's VideoDecoder does when it outputs NV12 8-bit from HEVC Main10 — and
// box-downsamples. No HLG→SDR tone mapping: the metric works on HLG code values, both sides alike.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lumaFromPlane, ssim, msssim, psnr, toDb, half } from '../../app/lib/quality.js';
import { planSegments, sourceBitrateSeries } from '../../app/lib/scenes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const SEG = +(args[args.indexOf('--seg') + 1] || 0) || 1.0;
const QUICK = args.includes('--quick');
const REF = process.env.CALIB_REF || join(ROOT, 'samples/IMG_7440.mov');
const DIST_DIR = process.env.CALIB_DIST || '/root/.claude/uploads/41829d04-493e-5956-8e38-1bd70ab69d5c';
const TAG = process.env.CALIB_TAG || 'v0.13';
const VMAF = process.env.VMAF || '/tmp/claude-0/lab/vmaf-src/libvmaf/build/tools/vmaf';
const MODELS = process.env.MODELS || '/tmp/claude-0/lab/vmaf-src/model';
const CACHE = process.env.CALIB_CACHE || join(process.env.TMPDIR || '/tmp', 'calib');

const skip = (m) => { console.log('SKIP:', m); process.exit(0); };
if (!existsSync(REF)) skip(`reference not found: ${REF}`);
if (!existsSync(DIST_DIR)) skip(`outputs dir not found: ${DIST_DIR}`);
const base = basename(REF).replace(/\.[^.]+$/, '');
const dists = readdirSync(DIST_DIR).map((f) => ({ f, m: f.match(new RegExp(`${base}_(\\d+)M_k4s_aCopy_${TAG.replace(/\./g, '\\.')}$`)) }))
  .filter((x) => x.m).map((x) => ({ path: join(DIST_DIR, x.f), mbps: +x.m[1] })).sort((a, b) => a.mbps - b.mbps);
if (dists.length < 2) skip(`need ≥2 outputs ${base}_<N>M_k4s_aCopy_${TAG} in ${DIST_DIR}`);
mkdirSync(CACHE, { recursive: true });

// ---------- helpers ----------
const probe = (f, entries, extra = []) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', ...extra, '-show_entries', entries, '-of', 'csv=p=0', f], { maxBuffer: 1 << 28 }).toString().trim().split('\n');
function dims(f) { const [w, h] = probe(f, 'stream=width,height')[0].split(',').map(Number); return { w, h }; }
function packets(f) { // presentation-ordered [{t, size, key}] for packets with pts ≥ 0
  return probe(f, 'packet=pts_time,size,flags').map((l) => l.split(',')).map(([t, s, fl]) => ({ t: +t, size: +s, key: fl.includes('K') }))
    .filter((p) => p.t >= 0).sort((a, b) => a.t - b.t);
}
function vmafFrames(dist, tag) {
  const out = join(CACHE, `vmaf_${tag}.json`);
  if (!existsSync(out)) {
    if (!existsSync(VMAF)) skip(`VMAF CLI not found (${VMAF}) and no cache ${out}`);
    const r = join(CACHE, 'ref.y4m'), d = join(CACHE, 'dist.y4m');
    if (!existsSync(r)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', REF, '-map', '0:v:0', '-an', '-strict', '-1', '-pix_fmt', 'yuv420p10le', r]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', dist, '-map', '0:v:0', '-an', '-strict', '-1', '-pix_fmt', 'yuv420p10le', d]);
    execFileSync(VMAF, ['-r', r, '-d', d, '--threads', '4', '--quiet', '--model', `path=${MODELS}/vmaf_v0.6.1.json:name=vmaf`, '--json', '-o', out]);
  }
  return JSON.parse(readFileSync(out, 'utf8')).frames.map((f) => f.metrics.vmaf);
}
class Reader { // exact-size frame reader over a child stdout
  constructor(file, w, h) {
    this.size = w * h * 2; this.chunks = []; this.len = 0; this.waiter = null; this.ended = false;
    this.p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-an', '-f', 'rawvideo', '-pix_fmt', 'gray10le', '-']);
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
function pearson(x, y) { const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n; let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sx * sy); }
const rank = (x) => { const idx = x.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(x.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const spearman = (x, y) => pearson(rank(x), rank(y));
function linfit(x, y) { const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n; let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; } const b = sxy / sxx, a = my - b * mx; const sd = Math.sqrt(y.reduce((s, v, i) => s + (v - a - b * x[i]) ** 2, 0) / (n - 2)); return { a, b, sd }; }
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const pct = (v, q) => { const s = [...v].sort((a, b) => a - b), p = (s.length - 1) * q, i = Math.floor(p); return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (p - i) : s[i]; };
function gradMag({ data, width, height }) { const o = new Float32Array(data.length); for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) { const i = y * width + x; o[i] = Math.abs(data[i + 1] - data[i]) + Math.abs(data[i + width] - data[i]); } return { data: o, width, height }; }

// ---------- per-frame metrics ----------
const { w: W, h: H } = dims(dists[0].path);
console.log(`ref ${basename(REF)}  dists: ${dists.map((d) => d.mbps + 'M').join(' ')}  ${W}×${H}  segment ${SEG}s`);
const VARIANTS = ['ssim_f1', 'ssim_f2', 'ssim_f4', 'msssim3_f1', 'msssim3_f2', 'psnr_f2', 'gssim_f2'];
const res = dists.map(() => Object.fromEntries(VARIANTS.map((v) => [v, []])));
const timing = Object.fromEntries(VARIANTS.map((v) => [v, 0]));
const cacheF = join(CACHE, `metrics_${base}_${TAG}_${QUICK ? 'q' : 'full'}.json`);
if (existsSync(cacheF)) Object.assign(res, JSON.parse(readFileSync(cacheF, 'utf8')));
else {
  const rr = new Reader(REF, W, H), dr = dists.map((d) => new Reader(d.path, W, H));
  const t = (k, fn) => { const t0 = performance.now(); const r = fn(); timing[k] += performance.now() - t0; return r; };
  for (let n = 0; ; n++) {
    const R = await rr.next(); if (!R) break;
    const Ds = await Promise.all(dr.map((r) => r.next()));
    const r1 = lumaFromPlane(R, W, H, W, { factor: 1, bitDepth: 10 }), r2 = lumaFromPlane(R, W, H, W, { factor: 2, bitDepth: 10 }), r4 = lumaFromPlane(R, W, H, W, { factor: 4, bitDepth: 10 });
    const g2 = gradMag(r2);
    Ds.forEach((D, k) => {
      const o = res[k];
      const d1 = lumaFromPlane(D, W, H, W, { factor: 1, bitDepth: 10 });
      const d2 = t('ssim_f2', () => lumaFromPlane(D, W, H, W, { factor: 2, bitDepth: 10 })), d4 = lumaFromPlane(D, W, H, W, { factor: 4, bitDepth: 10 });
      o.ssim_f2.push(t('ssim_f2', () => ssim(r2.data, d2.data, r2.width, r2.height).ssim));
      o.ssim_f4.push(t('ssim_f4', () => ssim(r4.data, d4.data, r4.width, r4.height).ssim));
      if (!QUICK) {
        o.ssim_f1.push(t('ssim_f1', () => ssim(r1.data, d1.data, W, H).ssim));
        o.msssim3_f1.push(t('msssim3_f1', () => msssim(r1.data, d1.data, W, H, 3)));
      } else { o.ssim_f1.push(NaN); o.msssim3_f1.push(NaN); }
      o.msssim3_f2.push(t('msssim3_f2', () => msssim(r2.data, d2.data, r2.width, r2.height, 3)));
      o.psnr_f2.push(t('psnr_f2', () => psnr(r2.data, d2.data)));
      o.gssim_f2.push(t('gssim_f2', () => { const gd = gradMag(d2); return ssim(g2.data, gd.data, g2.width, g2.height).ssim; }));
    });
    if (n % 100 === 0) process.stderr.write(`frame ${n}\n`);
  }
  const nF = res[0].ssim_f2.length;
  console.log(`frames ${nF}; ms/frame (Node, this machine): ` + VARIANTS.map((v) => `${v} ${(timing[v] / nF / dists.length).toFixed(2)}`).join(', '));
  writeFileSync(cacheF, JSON.stringify(res));
}

// ---------- analysis ----------
const refPk = packets(REF);
const vm = dists.map((d) => vmafFrames(d.path, `${base}_${d.mbps}M_${TAG}`));
const distPk = dists.map((d) => packets(d.path));
const N = Math.min(vm[0].length, res[0].ssim_f2.length, refPk.length);
const fps = N / (refPk[N - 1].t - refPk[0].t + (refPk[1].t - refPk[0].t));
const segLen = Math.max(1, Math.round(SEG * fps));
const segs = []; for (let s = 0; s + segLen / 2 <= N; s += segLen) segs.push([s, Math.min(N, s + segLen)]);
const xform = (v, x) => (v.startsWith('psnr') ? x : toDb(x));
console.log(`\n${N} frames, ${segs.length} segments of ${segLen} frames, pooled over ${dists.length} bitrates`);
console.log('variant      frame PLCC/SROCC   segment(mean) PLCC/SROCC  fit vmaf=a+b·x  sd   | p5 guard PLCC  sd');
const fits = {};
for (const v of VARIANTS) {
  if (res[0][v].some((x) => Number.isNaN(x))) continue;
  const fx = [], fy = [], sx = [], sy = [], lx = [], ly = [];
  dists.forEach((_, k) => {
    for (let i = 0; i < N; i++) { fx.push(xform(v, res[k][v][i])); fy.push(vm[k][i]); }
    for (const [a, b] of segs) {
      const xs = res[k][v].slice(a, b).map((x) => xform(v, x)), ys = vm[k].slice(a, b);
      sx.push(mean(xs)); sy.push(mean(ys)); lx.push(pct(xs, 0.05)); ly.push(pct(ys, 0.05));
    }
  });
  const f = linfit(sx, sy), fl = linfit(lx, ly);
  fits[v] = { ...f, aLow: fl.a, bLow: fl.b, sdLow: fl.sd, plcc: pearson(sx, sy), srocc: spearman(sx, sy), plccLow: pearson(lx, ly), sx, sy };
  console.log(`${v.padEnd(12)} ${pearson(fx, fy).toFixed(3)}/${spearman(fx, fy).toFixed(3)}        ${fits[v].plcc.toFixed(3)}/${fits[v].srocc.toFixed(3)}           a=${f.a.toFixed(2)} b=${f.b.toFixed(3)}  ${f.sd.toFixed(2)} | ${fits[v].plccLow.toFixed(3)}  ${fl.sd.toFixed(2)}`);
}

// within-segment discrimination: for each segment, does the metric rank the bitrates like VMAF? and
// cross-segment: does a single threshold pick the same bitrate as VMAF would?
const V = 'ssim_f2', F = fits[V], TARGET = +(process.env.CALIB_TARGET || 88);
const thr = (TARGET - F.a) / F.b, thrSafe = (TARGET + F.sd - F.a) / F.b;
console.log(`\nchosen ${V}: ssimDb for VMAF ${TARGET} = ${thr.toFixed(2)} dB (SSIM ${(1 - 10 ** (-thr / 10)).toFixed(4)}); with +1 sd margin ${thrSafe.toFixed(2)} dB (SSIM ${(1 - 10 ** (-thrSafe / 10)).toFixed(4)})`);
// per-segment required bitrate: actual bits of each output in the segment vs VMAF → interpolate (log-rate) the rate at TARGET
const interpRate = (rates, q, t) => { for (let i = 0; i + 1 < rates.length; i++) if ((q[i] - t) * (q[i + 1] - t) <= 0 && q[i] !== q[i + 1]) { const u = (t - q[i]) / (q[i + 1] - q[i]); return Math.exp(Math.log(rates[i]) + u * (Math.log(rates[i + 1]) - Math.log(rates[i]))); } return t < q[0] ? -rates[0] : Infinity; };
console.log('\nseg   t(s)    src Mbps | out Mbps @4..12 | VMAF @4..12 | est.VMAF(ssim) | need@88 VMAF  need@88 metric(+sd) | ratio need/src');
const segRows = [];
segs.forEach(([a, b], si) => {
  const dur = (b - a) / fps, src = refPk.slice(a, b).reduce((s, p) => s + p.size, 0) * 8 / dur / 1e6;
  const out = distPk.map((pk) => pk.slice(a, b).reduce((s, p) => s + p.size, 0) * 8 / dur / 1e6);
  const vv = vm.map((x) => mean(x.slice(a, b)));
  const est = dists.map((_, k) => F.a + F.b * mean(res[k][V].slice(a, b).map(toDb)));
  const needV = interpRate(out, vv, TARGET), needM = interpRate(out, est, TARGET + F.sd);
  segRows.push({ src, needV, needM });
  console.log(`${String(si).padStart(3)} ${(a / fps).toFixed(1).padStart(5)}  ${src.toFixed(1).padStart(6)}   | ${out.map((x) => x.toFixed(1)).join(' ')} | ${vv.map((x) => x.toFixed(1)).join(' ')} | ${est.map((x) => x.toFixed(1)).join(' ')} | ${needV.toFixed(2).padStart(6)}   ${needM.toFixed(2).padStart(6)} | ${(needV / src).toFixed(3)}`);
});
const ok = segRows.filter((r) => Number.isFinite(r.needV) && r.needV > 0);
console.log(`\nrequired-rate prior: need/src ratio mean ${mean(ok.map((r) => r.needV / r.src)).toFixed(3)} (min ${Math.min(...ok.map((r) => r.needV / r.src)).toFixed(3)}, max ${Math.max(...ok.map((r) => r.needV / r.src)).toFixed(3)}); corr(src, need) ${pearson(ok.map((r) => r.src), ok.map((r) => r.needV)).toFixed(3)}`);
const lf = linfit(ok.map((r) => Math.log(r.src)), ok.map((r) => Math.log(r.needV)));
console.log(`log-log fit need = exp(${lf.a.toFixed(3)}) · src^${lf.b.toFixed(3)}  (sd log ${lf.sd.toFixed(3)})`);
console.log(`metric-based need vs VMAF-based need: mean ratio ${mean(ok.filter((r) => Number.isFinite(r.needM) && r.needM > 0).map((r) => r.needM / r.needV)).toFixed(3)}`);

// scene planner on the source packets (sanity)
const series = sourceBitrateSeries(refPk.slice(0, N).map((p) => ({ size: p.size, key: p.key, dur: 1 / fps })));
const plan = planSegments(refPk.slice(0, N).map((p) => ({ size: p.size, key: p.key, dur: 1 / fps })), {});
console.log(`\nplanSegments on source: ${plan.map((s) => `[${s.startIdx}-${s.endIdx}] ${(s.srcBitrate / 1e6).toFixed(1)}M c=${s.complexity.toFixed(2)}`).join('  ')} (series len ${series.length})`);
console.log('\nDEFAULT_CALIBRATION =', JSON.stringify({ metric: 'ssimDb', factor: 2, segmentSec: SEG, a: +F.a.toFixed(3), b: +F.b.toFixed(4), sd: +F.sd.toFixed(2), aLow: +F.aLow.toFixed(3), bLow: +F.bLow.toFixed(4), sdLow: +F.sdLow.toFixed(2), plcc: +F.plcc.toFixed(3), srocc: +F.srocc.toFixed(3) }));
