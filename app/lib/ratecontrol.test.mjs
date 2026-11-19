// Run: node --test app/lib/ratecontrol.test.mjs   (pure Node, no media files, no browser)
// Covers quality.js (pure core), scenes.js and ratecontrol.js with stubbed encode/measure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lumaFromPlane, lumaFromRGBA, rotateLuma, ssim, msssim, psnr, frameScore, pool, estimateVmaf, dbForVmaf, toDb, DEFAULT_CALIBRATION as CAL } from './quality.js';
import { sourceBitrateSeries, detectCuts, segmentScenes, pickTrialWindow } from './scenes.js';
import { planSegments, searchBitrate, runSearch, solveRate, encodeSchedule, expectedBitrate, predictBitrate, DEFAULTS } from './ratecontrol.js';

// ---------- helpers ----------
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function texture(w, h, seed = 1) { const r = rng(seed), a = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = 128 + 60 * Math.sin(x / 7 + seed) * Math.cos(y / 11) + 30 * (r() - 0.5); return a; }
function addNoise(a, amp, seed = 9) { const r = rng(seed); return a.map((v) => v + amp * (r() - 0.5)); }
// synthetic camera packets: GOP of 28 (I, then P every 4th, B otherwise) at 60 fps
function camPackets(n, { rate = (i) => 1, cutAt = [] } = {}) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const k = i % 28 === 0, P = i % 4 === 0;
    let size = (k ? 250e3 : P ? 90e3 : 18e3) * rate(i);
    if (cutAt.includes(i) && !k) size = 400e3;
    p.push({ size, key: k, dur: 1 / 60 });
  }
  return p;
}

// ---------- quality.js ----------
test('ssim: identical = 1, more noise = lower, dB monotone', () => {
  const w = 96, h = 64, a = texture(w, h);
  assert.ok(Math.abs(ssim(a, a, w, h).ssim - 1) < 1e-9);
  const s1 = ssim(a, addNoise(a, 6), w, h).ssim, s2 = ssim(a, addNoise(a, 20), w, h).ssim;
  assert.ok(s1 < 1 && s2 < s1, `${s1} ${s2}`);
  assert.ok(toDb(s1) > toDb(s2));
  assert.ok(Math.abs(msssim(a, a, w, h, 3) - 1) < 1e-9);
  assert.ok(msssim(a, addNoise(a, 20), w, h, 3) < 1);
  assert.equal(psnr(a, a), 100);
});

test('lumaFromPlane: 10-bit → 8-bit rounding and box downsample', () => {
  const p = new Uint16Array([64, 66, 940, 1023, 64, 66, 940, 1023]); // 2 rows × 4
  const full = lumaFromPlane(p, 4, 2, 4, { factor: 1, bitDepth: 10 });
  assert.deepEqual([...full.data.slice(0, 4)], [16, 17, 235, 255]); // (y+2)>>2, clamp
  const half = lumaFromPlane(p, 4, 2, 4, { factor: 2, bitDepth: 10 });
  assert.equal(half.width, 2); assert.equal(half.height, 1);
  assert.deepEqual([...half.data], [16.5, 245]);
  // stride + offset (NV12 copyTo layout)
  const buf = new Uint8Array([0, 0, 10, 20, 99, 30, 40, 99]);
  const l = lumaFromPlane(buf, 2, 2, 3, { factor: 1, offset: 2 });
  assert.deepEqual([...l.data], [10, 20, 30, 40]);
});

test('lumaFromRGBA maps full-range grey to limited range', () => {
  const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  const l = lumaFromRGBA(px, 2, 1);
  assert.deepEqual([...l.data], [16, 235]);
});

test('rotateLuma 90/270/180 round trips', () => {
  const img = { data: Float32Array.from([1, 2, 3, 4, 5, 6]), width: 3, height: 2 };
  const r90 = rotateLuma(img, 90);
  assert.equal(r90.width, 2); assert.equal(r90.height, 3);
  assert.deepEqual([...r90.data], [4, 1, 5, 2, 6, 3]);
  assert.deepEqual([...rotateLuma(r90, 270).data], [...img.data]);
  assert.deepEqual([...rotateLuma(rotateLuma(img, 180), 180).data], [...img.data]);
});

test('frameScore size check, pool, calibration inverse', () => {
  const w = 64, h = 64, a = texture(w, h);
  assert.throws(() => frameScore({ data: a, width: w, height: h }, { data: a, width: 32, height: 128 }));
  const p = pool([10, 12, 14, 16, 18]);
  assert.equal(p.mean, 14); assert.equal(p.min, 10); assert.ok(p.low > 10 && p.low < 12);
  const db = dbForVmaf(88, CAL, 0);
  assert.ok(Math.abs(estimateVmaf({ mean: db, low: db }).mean - 88) < 1e-9);
  assert.ok(dbForVmaf(88, CAL, 1) > db);
});

// ---------- scenes.js ----------
test('sourceBitrateSeries: one unit per source GOP', () => {
  const u = sourceBitrateSeries(camPackets(28 * 5));
  assert.equal(u.length, 5);
  assert.ok(u.every((x) => x.endIdx - x.startIdx === 28));
});

test('detectCuts: spike on a non-key packet, not on normal P frames', () => {
  const p = camPackets(600, { cutAt: [301] });
  assert.deepEqual(detectCuts(p), [301]);
  assert.deepEqual(detectCuts(camPackets(600)), []);
});

test('segmentScenes: splits at a rate change, respects min/max length, covers all frames', () => {
  const n = 60 * 12; // 12 s: 0–6 s rate ×1, 6–12 s rate ×3
  const p = camPackets(n, { rate: (i) => (i < 360 ? 1 : 3) });
  const s = segmentScenes(p, { minSec: 2, maxSec: 8 });
  assert.equal(s[0].startIdx, 0); assert.equal(s.at(-1).endIdx, n);
  for (let i = 1; i < s.length; i++) assert.equal(s[i].startIdx, s[i - 1].endIdx);
  for (const x of s) assert.ok(x.duration >= 2 - 1e-9 && x.duration <= 8 + 0.5, `dur ${x.duration}`);
  const b = s.map((x) => x.startIdx);
  assert.ok(b.some((i) => Math.abs(i - 360) <= 28), `boundary near 6 s: ${b}`);
  assert.ok(s.at(-1).complexity > s[0].complexity * 2);
});

test('segmentScenes: a cut forces a boundary', () => {
  const p = camPackets(60 * 8, { cutAt: [250] });
  const s = segmentScenes(p, { minSec: 2, maxSec: 8 });
  assert.ok(s.some((x) => x.startIdx === 250 && x.cutAtStart), JSON.stringify(s.map((x) => x.startIdx)));
});

test('segmentScenes: short clip = one segment', () => {
  const s = segmentScenes(camPackets(150));
  assert.equal(s.length, 1); assert.equal(s[0].endIdx, 150);
});

test('pickTrialWindow: key-aligned, ~1 s, centre or max-rate', () => {
  const p = camPackets(60 * 4, { rate: (i) => (i >= 168 && i < 224 ? 3 : 1) });
  const seg = { startIdx: 0, endIdx: 240 };
  const c = pickTrialWindow(p, seg, 1, 'center');
  assert.ok(p[c.startIdx].key); assert.equal(c.endIdx - c.startIdx, 60);
  assert.equal(c.startIdx, 84); // window centre 112 closest to 120
  const m = pickTrialWindow(p, seg, 1, 'max');
  assert.equal(m.startIdx, 168);
});

// ---------- ratecontrol.js ----------
// Stub world: each segment has a hidden need N_s (bit/s) where TRUE VMAF = 88; VMAF rises
// SLOPE points per doubling. measure() returns per-frame ssimDb that the calibration maps back to
// that VMAF exactly, with the 5th percentile 10 VMAF lower.
const SLOPE = 10;
function world(needOf) {
  const calls = { encode: 0, frames: 0, rates: [] };
  const vmafAt = (need, r) => 88 + SLOPE * Math.log2(r / need);
  const deps = {
    encodeTrial: async (w, rates) => { calls.encode++; calls.frames += w.endIdx - w.startIdx; calls.rates.push(rates); return rates.map((r) => ({ bitrate: r, bytes: r / 8, encoded: { r, need: needOf(w) } })); },
    measure: async (w, e) => {
      const v = vmafAt(e.need, e.r), n = w.endIdx - w.startIdx;
      const mean = (v - CAL.a) / CAL.b, low = (v - 10 - CAL.aLow) / CAL.bLow;
      // 90 % of frames at `hi`, 10 % at `low` → p5 ≈ low; mean adjusted to stay exact
      const nl = Math.max(1, Math.round(n * 0.1)), hi = (mean * n - low * nl) / (n - nl);
      return Array.from({ length: n }, (_, i) => (i < nl ? low : hi));
    },
  };
  return { deps, calls, vmafAt };
}
const expected = (need) => need * 2 ** (CAL.sd * DEFAULTS.marginSd / SLOPE);

test('solveRate: interpolation and bounded extrapolation in log-rate', () => {
  const pts = [{ bitrate: 4e6, q: 80 }, { bitrate: 8e6, q: 90 }];
  assert.ok(Math.abs(solveRate(pts, 85) - Math.sqrt(32) * 1e6) < 1);
  assert.ok(Math.abs(solveRate(pts, 100) - 16e6) < 1);
  assert.ok(Math.abs(solveRate([{ bitrate: 8e6, q: 88 }], 98, 10) - 16e6) < 1);
  // implausibly flat measured slope is clamped (≥ slope/2) → no runaway
  assert.ok(solveRate([{ bitrate: 4e6, q: 80 }, { bitrate: 8e6, q: 80.1 }], 90, 10) <= 8e6 * 4 + 1);
});

test('searchBitrate finds need × margin within 3 % in one round when the prior is close', async () => {
  for (const need of [3e6, 6e6, 9e6]) {
    const { deps, calls } = world(() => need);
    const seg = { trialWindow: { startIdx: 0, endIdx: 60, srcBitrate: need / 0.4 }, prior: need * 1.1 };
    const r = await searchBitrate(seg, deps);
    assert.equal(r.rounds, 1); assert.equal(calls.encode, 1);
    assert.equal(calls.rates[0].length, 2, 'round 1 = two bitrates in one encodeTrial call (parallel)');
    assert.ok(Math.abs(r.bitrate / expected(need) - 1) < 0.03, `${need}: ${r.bitrate} vs ${expected(need)}`);
    assert.ok(Math.abs(r.est.mean - (88 + CAL.sd)) < 0.3);
  }
});

test('searchBitrate refines once when the prior is far off', async () => {
  const need = 12e6, { deps, calls } = world(() => need);
  const r = await searchBitrate({ trialWindow: { startIdx: 0, endIdx: 60, srcBitrate: 10e6 }, prior: 4e6 }, deps);
  assert.equal(r.rounds, 2); assert.equal(calls.encode, 2);
  assert.ok(Math.abs(r.bitrate / expected(need) - 1) < 0.05, `${r.bitrate}`);
});

test('searchBitrate clamps to [2, 20] Mbps', async () => {
  const lo = await searchBitrate({ trialWindow: { startIdx: 0, endIdx: 60, srcBitrate: 1e6 }, prior: 2e6 }, world(() => 0.5e6).deps);
  assert.equal(lo.bitrate, 2e6); assert.equal(lo.reason, 'clamped-min');
  const hi = await searchBitrate({ trialWindow: { startIdx: 0, endIdx: 60, srcBitrate: 90e6 }, prior: 20e6 }, world(() => 40e6).deps);
  assert.equal(hi.bitrate, 20e6); assert.equal(hi.reason, 'clamped-max');
});

test('searchBitrate: the low-percentile guard can dominate', async () => {
  const need = 6e6, { deps } = world(() => need);
  const strict = await searchBitrate({ trialWindow: { startIdx: 0, endIdx: 60, srcBitrate: 15e6 }, prior: 6e6 }, deps, { lowVmaf: 84 });
  const normal = await searchBitrate({ trialWindow: { startIdx: 0, endIdx: 60, srcBitrate: 15e6 }, prior: 6e6 }, deps);
  assert.ok(strict.bitrate > normal.bitrate * 1.2, `${strict.bitrate} vs ${normal.bitrate}`);
});

test('planSegments + runSearch end to end with budget and untested-segment safety', async () => {
  const n = 60 * 12;
  const frames = Array.from({ length: n }, (_, i) => ({ ts: i / 60, dur: 1 / 60 }));
  const pk = camPackets(n, { rate: (i) => (i < 360 ? 1 : 2.5) });
  const needOf = (w) => (w.startIdx < 360 ? 5e6 : 10e6);
  const plan = planSegments(frames, pk, { segment: { minSec: 2, maxSec: 4 } });
  assert.ok(plan.segments.length >= 3);
  assert.ok(plan.trialFrames <= plan.budgetFrames);
  const { deps, calls } = world(needOf);
  const out = await runSearch(plan, deps);
  assert.ok(calls.frames <= plan.budgetFrames + 60);
  for (const s of out.segments) {
    const need = needOf(s.trialWindow ?? s);
    if (s.trial) assert.ok(Math.abs(s.bitrate / expected(need) - 1) < 0.05, `tested ${s.startIdx}: ${s.bitrate} vs ${expected(need)}`);
    else assert.ok(s.bitrate >= 2e6);
  }
  // with budget 0 except the forced one, untested segments get prior × correction × safety
  const plan2 = planSegments(frames, pk, { budget: 0 });
  assert.equal(plan2.segments.filter((s) => s.trial).length, 1);
  const out2 = await runSearch(plan2, world(needOf).deps);
  const t = out2.segments.find((s) => s.trial), u = out2.segments.find((s) => !s.trial);
  const corr = t.bitrate / t.prior;
  assert.ok(Math.abs(u.bitrate / (u.prior * corr * DEFAULTS.untestedSafety) - 1) < 0.02);
  assert.ok(expectedBitrate(out.segments) > 2e6);
});

test('encodeSchedule: keyframe + bitrate at segment starts, periodic GOP inside, skip tiny changes', () => {
  const segs = [{ startIdx: 0, bitrate: 8e6 }, { startIdx: 100, bitrate: 8.2e6 }, { startIdx: 200, bitrate: 12e6 }];
  const ctl = encodeSchedule(segs, { gopFrames: 60 });
  const seq = Array.from({ length: 300 }, (_, i) => ctl(i));
  assert.deepEqual(seq[0], { keyFrame: true, bitrate: 8e6 });
  assert.deepEqual(seq[60], { keyFrame: true, bitrate: null });
  assert.deepEqual(seq[100], { keyFrame: true, bitrate: null }); // +2.5 % < 8 % → no configure()
  assert.deepEqual(seq[160], { keyFrame: true, bitrate: null }); // GOP counted from segment start
  assert.deepEqual(seq[200], { keyFrame: true, bitrate: 12e6 });
  assert.equal(seq.filter((x) => x.keyFrame).length, 6); // 0,60,100,160,200,260
});

test('predictBitrate: prior ≈ 0.4 × source, clamped', () => {
  assert.equal(predictBitrate(20e6), 8e6);
  assert.equal(predictBitrate(100e6), 20e6);
  assert.equal(predictBitrate(1e6), 2e6);
});
