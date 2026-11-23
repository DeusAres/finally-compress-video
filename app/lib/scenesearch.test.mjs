// Run: node --test app/lib/scenesearch.test.mjs   (pure Node, stubbed encode/measure; no browser)
// Covers the «qualità per scena» wiring (scenesearch.js): plan aligned to export segments, ceiling, resume
// from saved records, fallback on trial errors, per-segment closed-loop controller, summary/log lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSceneSegments, centerWindow, runSceneSearch, sceneSummary, sceneLine, lumaU8FromRGBA, warmPrior, timingLine, createTrialDeps, toRecord } from './scenesearch.js';
import { searchBitrate } from './ratecontrol.js';
import { planSegments } from './jobstore.js';
import { nextBitrate, createSegmentRate } from './brctl.js';
import { DEFAULT_CALIBRATION as CAL } from './quality.js';

const fps = 60, N = 12 * fps; // 12 s clip, source ~20 Mbps
const frames = Array.from({ length: N }, (_, i) => ({ ts: i / fps, dur: 1 / fps, size: (i % 28 === 0 ? 250e3 : 30e3), key: i % 28 === 0 }));
const segStarts = planSegments(N, fps, 4 * fps);

// stub "content": needed real bitrate per segment (VMAF hits 88+margin there), slope 10 VMAF per doubling
const need = (k) => [5e6, 11e6, 3e6][k % 3];
const tMean = 88 + CAL.sd;
const qAt = (k, b) => tMean + 10 * Math.log2(b / need(k));
const dbFor = (q) => (q - CAL.a) / CAL.b;
function stubDeps({ failAt = new Set(), speed = 1, calls = [] } = {}) {
  let cur = 0;
  return {
    calls,
    async encodeTrial(w, rates) {
      const k = segStarts.findIndex((s, i) => w.startIdx >= s && w.startIdx < (segStarts[i + 1] ?? N)); cur = k; calls.push([k, rates]);
      if (failAt.has(k)) throw new Error('VideoDecoder: stub failure');
      // real bitrate = configured × speed (VT fed faster than real time produces less)
      return rates.map((r) => ({ bitrate: r * speed, requested: r, bytes: r * speed / 8, encoded: { k, b: r * speed } }));
    },
    async measure(w, enc) { const q = qAt(enc.k, enc.b); return Array.from({ length: 30 }, (_, i) => dbFor(q) + (i % 2 ? 0.05 : -0.05)); },
    release() {},
  };
}

test('plan: one search segment per export segment, centred 1 s window, prior capped at the user bitrate', () => {
  const plan = planSceneSegments(frames, segStarts, 8e6);
  assert.equal(plan.length, segStarts.length);
  plan.forEach((p, k) => {
    assert.equal(p.startIdx, segStarts[k]);
    const w = p.trialWindow; assert.ok(w.startIdx >= p.startIdx && w.endIdx <= p.endIdx);
    assert.equal(w.endIdx - w.startIdx, 60);
    const mid = (p.startIdx + p.endIdx) / 2, wm = (w.startIdx + w.endIdx) / 2; assert.ok(Math.abs(mid - wm) <= 1, `${mid} ${wm}`);
    assert.ok(p.prior <= 8e6 && p.prior >= 2e6);
  });
  // no sizes → prior = ceiling
  const bare = planSceneSegments(frames.map((f) => ({ dur: f.dur })), segStarts, 6e6);
  assert.ok(bare.every((p) => p.prior === 6e6));
  // tiny segment: window = whole segment
  const w = centerWindow(frames, 0, 30, 1); assert.deepEqual([w.startIdx, w.endIdx], [0, 30]);
});

test('runSceneSearch: picks ~the needed bitrate, never above the ceiling, logs the scene line', async () => {
  const plan = planSceneSegments(frames, segStarts, 12e6), saved = {}, lines = [];
  const recs = await runSceneSearch({ plan, deps: stubDeps(), ceiling: 12e6, save: async (k, r) => { saved[k] = r; }, log: (t) => lines.push(t) });
  recs.forEach((r, k) => {
    assert.ok(r.b <= 12e6);
    assert.ok(Math.abs(Math.log2(r.b / need(k))) < 0.08, `seg ${k}: ${r.b} vs ${need(k)}`);
    assert.equal(saved[k], r);
    assert.ok(r.est.q >= 88 + CAL.sd - 0.6, `est ${r.est.q}`);
  });
  assert.match(lines[0], /^scena 1: prove a [\d.]+\/[\d.]+ Mbps → VMAF stimato [\d.]+\/[\d.]+ → scelto [\d.]+ Mbps/);
  // ceiling below the need → clamped at the user bitrate, flagged
  const low = await runSceneSearch({ plan: planSceneSegments(frames, segStarts, 8e6), deps: stubDeps(), ceiling: 8e6 });
  assert.equal(low[1].b, 8e6); assert.equal(low[1].why, 'clamped-max');
});

test('points use the REAL trial bitrate (VT slower than configured): choice is a real-bitrate target', async () => {
  const plan = planSceneSegments(frames, segStarts, 20e6);
  const recs = await runSceneSearch({ plan, deps: stubDeps({ speed: 0.66 }), ceiling: 20e6 });
  recs.forEach((r, k) => assert.ok(Math.abs(Math.log2(r.b / need(k))) < 0.08, `seg ${k}: ${r.b}`));
});

test('resume: saved records are reused without trials; trial errors fall back to the user bitrate', async () => {
  const plan = planSceneSegments(frames, segStarts, 10e6), calls = [];
  const saved = { 0: { b: 4.2e6, why: 'searched', pts: [], est: { q: 90, ql: 80 }, ms: 1000 } };
  const lines = [];
  const recs = await runSceneSearch({ plan, from: 0, saved, deps: stubDeps({ failAt: new Set([1]), calls }), ceiling: 10e6, log: (t) => lines.push(t) });
  assert.equal(recs[0], saved[0]);
  assert.ok(!calls.some(([k]) => k === 0), 'segment 0 must not be re-tested');
  assert.equal(recs[1].b, 10e6); assert.equal(recs[1].why, 'fallback');
  assert.ok(lines.some((l) => /scena 2: prove fallite .* ripiego a 10\.0 Mbps/.test(l)));
  assert.equal(recs[2].why, 'searched');
  // from > 0: earlier segments are not searched
  const r2 = await runSceneSearch({ plan, from: 2, deps: stubDeps(), ceiling: 10e6 });
  assert.equal(r2[0], null); assert.ok(r2[2]);
  // repeated failures switch trials off for the rest
  const r3 = await runSceneSearch({ plan, deps: stubDeps({ failAt: new Set([0, 1, 2]) }), ceiling: 10e6 });
  assert.deepEqual(r3.slice(0, 2).map((r) => r.why), ['fallback', 'fallback']);
  assert.ok(r3.slice(2).every((r) => r.why === 'off' && r.b === 10e6));
});

test('fatal errors (background interrupt) are rethrown, not absorbed', async () => {
  const plan = planSceneSegments(frames, segStarts, 10e6);
  const deps = stubDeps(); deps.encodeTrial = async () => { throw Object.assign(new Error('bg'), { name: 'BackgroundInterrupt' }); };
  await assert.rejects(runSceneSearch({ plan, deps, ceiling: 10e6, isFatal: (e) => e.name === 'BackgroundInterrupt' }), /bg/);
});

test('createSegmentRate: identical to v0.27 control at a fixed target; per-segment targets keep the learned ratio', () => {
  // fixed target
  let conf = 8e6; const rc = createSegmentRate(() => 8e6, 1);
  for (const real of [6e6, 7e6, 7.8e6]) { conf = nextBitrate(conf, real, 8e6); assert.equal(rc.update(0, real), conf); }
  // VT produces 0.66 × configured: after convergence on segment 0 (target 5), segment 1 (target 10) starts at ~10/0.66
  const t = [5e6, 10e6], rc2 = createSegmentRate((s) => t[s], 1);
  let c = rc2.configured(0); for (let w = 0; w < 6; w++) c = rc2.update(0, c * 0.66, 0);
  assert.ok(Math.abs(c * 0.66 / 5e6 - 1) < 0.03);
  const c1 = rc2.configured(1); assert.ok(Math.abs(c1 * 0.66 / 10e6 - 1) < 0.03, `${c1}`);
  // a late window of segment 0 measured while segment 1 is being fed → bitrate for segment 1
  const c2 = rc2.update(0, 5e6, 1); assert.ok(Math.abs(c2 / rc2.ratio - 10e6) < 1);
  assert.equal(createSegmentRate(() => 8e6, 9).ratio, 2.5); // resume ratio clamped
  // content-limited window (static scene: real ≪ target) does not inflate the ratio when holdBelow is set
  const rc3 = createSegmentRate((s) => [2e6, 10e6][s], 1, { holdBelow: 0.5 });
  for (let w = 0; w < 4; w++) rc3.update(0, 0.1e6, 0);
  assert.equal(rc3.ratio, 1); assert.equal(rc3.configured(1), 10e6);
  const rc4 = createSegmentRate(() => 2e6, 1); for (let w = 0; w < 4; w++) rc4.update(0, 0.1e6); assert.equal(rc4.ratio, 2.5); // v0.27 behaviour
});

test('summary and log lines', () => {
  const segs = [{ duration: 4 }, { duration: 4 }, { duration: 2 }];
  const recs = [{ b: 5e6, why: 'searched', est: { q: 90.1 }, ms: 2000, pts: [{ b: 4e6, q: 86 }, { b: 6e6, q: 92 }] }, { b: 8e6, why: 'clamped-max', est: { q: 87 }, ms: 2500, pts: [{ b: 6e6, q: 84 }, { b: 8e6, q: 87 }] }, { b: 8e6, why: 'fallback', est: null, ms: 0, pts: [] }];
  const s = sceneSummary(segs, recs, [5.1e6, 7.9e6, 8e6]);
  assert.equal(s.min, 5e6); assert.equal(s.max, 8e6); assert.equal(s.mean, (5 * 4 + 8 * 4 + 8 * 2) / 10 * 1e6);
  assert.equal(s.vmafMin, 87); assert.equal(s.trialS, 4.5); assert.equal(s.fallbacks, 1); assert.equal(s.capped, 1);
  assert.equal(s.dist, '5–6 Mbps ×1 · 8–9 Mbps ×2');
  assert.equal(sceneLine(0, recs[0], 5.1e6), 'scena 1: prove a 4.0/6.0 Mbps → VMAF stimato 86.0/92.0 → scelto 5.0 Mbps (reale 5.1 Mbps)');
  assert.match(sceneLine(2, recs[2]), /nessuna prova.*8\.0 Mbps.*bitrate dell'utente/);
  const l = lumaU8FromRGBA(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1);
  assert.deepEqual([...l.data], [16, 235]);
});

// ---------------------------------------------------------------------------------------------
// v0.35: ricerca più veloce (research/12 §12)
// ---------------------------------------------------------------------------------------------
function counting(needB, { stream = false } = {}) { // mondo a un segmento: VMAF = tMean + 10·log2(b/need)
  const c = { encodes: [], measures: 0, streamReq: [] };
  const mk = (b) => { const q = tMean + 10 * Math.log2(b / needB); return Array.from({ length: 30 }, (_, i) => dbFor(q) + (i % 2 ? 0.05 : -0.05)); };
  return { c, deps: {
    async encodeTrial(w, rates, o = {}) { c.encodes.push(rates); c.streamReq.push(o.stream);
      return rates.map((r, i) => ({ bitrate: r, requested: r, bytes: r / 8, encoded: { b: r }, ...(stream && o.stream?.[i] ? { dbs: mk(r) } : {}) })); },
    async measure(w, e) { c.measures++; return mk(e.b); } } };
}
const W1 = { startIdx: 0, endIdx: 60, srcBitrate: 20e6 };

test('ceiling-first: prior at the ceiling and the ceiling already misses → clamped-max after ONE measurement', async () => {
  const { c, deps } = counting(14e6);
  const r = await searchBitrate({ trialWindow: W1, prior: 8e6 }, deps, { maxBitrate: 8e6 });
  assert.equal(r.reason, 'clamped-max'); assert.equal(r.bitrate, 8e6);
  assert.equal(c.encodes.length, 1); assert.equal(c.encodes[0][0], 8e6, 'the ceiling is the first (measured) rate');
  assert.deepEqual(c.streamReq[0], [true, false], 'only the ceiling is measured while encoding');
  assert.equal(c.measures, 1); assert.equal(r.stats.measures, 1); assert.ok(r.stats.ceilingFirst);
  assert.ok(r.est.mean < tMean);
  // the old policy measured both rates
  const old = counting(14e6); const r0 = await searchBitrate({ trialWindow: W1, prior: 8e6 }, old.deps, { maxBitrate: 8e6, fast: false });
  assert.equal(r0.reason, 'clamped-max'); assert.equal(old.c.measures, 2);
});

test('ceiling-first: the ceiling passes → the lower trial (already encoded) is measured, same answer as before', async () => {
  for (const need of [7e6, 5e6]) {
    const { c, deps } = counting(need); const old = counting(need);
    const r = await searchBitrate({ trialWindow: W1, prior: 8e6 }, deps, { maxBitrate: 8e6 });
    const r0 = await searchBitrate({ trialWindow: W1, prior: 8e6 }, old.deps, { maxBitrate: 8e6, fast: false });
    assert.equal(c.encodes.length, 1, 'no extra extraction'); assert.equal(c.measures, 2);
    assert.ok(r.est.mean >= tMean - 0.3, `${need}: est ${r.est.mean}`);
    assert.ok(Math.abs(Math.log2(r.bitrate / need)) < 0.06 || r.bitrate >= need, `${need}: ${r.bitrate}`);
    assert.ok(r.bitrate >= r0.bitrate * 0.97, 'never below the old choice by more than rounding');
  }
});

test('easy content: lowest point far above target → no 2nd round, conservative descent (≤ one halving, est ≥ target)', async () => {
  const need = 4e6, { c, deps } = counting(need);
  const r = await searchBitrate({ trialWindow: W1, prior: 8e6 }, deps, { maxBitrate: 12e6 });
  assert.equal(r.rounds, 1); assert.equal(c.encodes.length, 1); assert.ok(r.stats.easy);
  const lo = 8e6 / 1.3;
  assert.ok(r.bitrate >= lo / 2 - 1e4, `${r.bitrate}`);
  assert.ok(r.bitrate >= need, 'conservative: never below the true need');
  assert.ok(r.est.mean >= tMean - 0.05, `est ${r.est.mean}`);
  // a measured slope flatter than the standard one does not make the descent faster
  const flat = { async encodeTrial(w, rates) { return rates.map((rr) => ({ bitrate: rr, bytes: 0, encoded: { b: rr } })); },
    async measure(w, e) { const q = tMean + 6 + 4 * Math.log2(e.b / 4e6); return [dbFor(q), dbFor(q)]; } };
  const rf = await searchBitrate({ trialWindow: W1, prior: 5e6 }, flat, { maxBitrate: 12e6 });
  const p0 = 5e6 / 1.3, q0 = tMean + 6 + 4 * Math.log2(p0 / 4e6);
  assert.ok(rf.bitrate >= p0 * 2 ** (-(q0 - tMean) / 10) - 1e4, `${rf.bitrate}`);
  // much easier than one halving below the tested point → verified by a 2nd round as before
  const x = counting(2.5e6), rx = await searchBitrate({ trialWindow: W1, prior: 8e6 }, x.deps, { maxBitrate: 12e6 });
  assert.equal(rx.rounds, 2); assert.ok(Math.abs(Math.log2(rx.bitrate / 2.5e6)) < 0.06, `${rx.bitrate}`);
});

test('hard content below the ceiling still gets the 2nd round (upward extrapolation is never trusted)', async () => {
  const { c, deps } = counting(9e6);
  const r = await searchBitrate({ trialWindow: W1, prior: 4e6 }, deps, { maxBitrate: 20e6 });
  assert.equal(r.rounds, 2); assert.equal(c.encodes.length, 2);
  assert.ok(Math.abs(Math.log2(r.bitrate / 9e6)) < 0.05);
});

test('streamed measurements (dbs from encodeTrial) replace measure()', async () => {
  const { c, deps } = counting(6e6, { stream: true });
  const r = await searchBitrate({ trialWindow: W1, prior: 6e6 }, deps, { maxBitrate: 12e6 });
  assert.equal(c.measures, 0); assert.equal(r.stats.streamed, 2); assert.equal(r.stats.measures, 2);
  assert.ok(Math.abs(Math.log2(r.bitrate / 6e6)) < 0.05);
  const rec = toRecord(r, 1234, 'prev');
  assert.deepEqual(rec.n, { e: 2, m: 2, s: 2, r: 1 }); assert.equal(rec.pf, 'prev');
});

test('warm start: the next segment starts from the previous choice; IMG_3053-like clip = 1 measurement per segment', async () => {
  assert.equal(warmPrior({ b: 5e6, why: 'searched' }, 8e6), 5e6);
  assert.equal(warmPrior({ b: 8e6, why: 'clamped-max' }, 8e6), 8e6);
  assert.equal(warmPrior({ b: 8e6, why: 'fallback' }, 8e6), null);
  assert.equal(warmPrior(null, 8e6), null);
  // two segments both needing more than the 8 Mbps ceiling (IMG_3053 on device): v0.34 = 2 encoders + 2 measures each
  const fr = Array.from({ length: 480 }, (_, i) => ({ ts: i / 60, dur: 1 / 60, size: 60e3 })); // ~29 Mbps source → prior 8 (ceiling)
  const st = planSegments(480, 60, 240), plan = planSceneSegments(fr, st, 8e6);
  const { c, deps } = counting(13e6), lines = [];
  const recs = await runSceneSearch({ plan, deps, ceiling: 8e6, log: (t) => lines.push(t) });
  assert.deepEqual(recs.map((r) => r.why), ['clamped-max', 'clamped-max']);
  assert.equal(c.measures, 2); assert.equal(c.encodes.length, 2);
  assert.match(lines[0], /1 giro, 2 enc\/1 misura, limite per primo/);
  // a searched segment seeds the bracket of the next one
  const plan2 = planSceneSegments(fr, st, 20e6), w2 = counting(6e6);
  const recs2 = await runSceneSearch({ plan: plan2, deps: w2.deps, ceiling: 20e6 });
  assert.equal(recs2[1].pf, 'prev');
  const mid = Math.sqrt(w2.c.encodes[w2.c.encodes.length - 1][0] * w2.c.encodes[w2.c.encodes.length - 1][1]);
  assert.ok(Math.abs(Math.log2(mid / Math.sqrt(recs2[0].b * plan2[1].prior))) < 0.02, `${mid} vs ${recs2[0].b}`);
  assert.equal(warmPrior({ b: 4e6, why: 'searched' }, 20e6, 2e6, 9e6), 6e6);
  assert.equal(recs2[1].n.r, 1);
});

test('timingLine: compact per-job breakdown', () => {
  const T = { extract: 1200, frames: 120, players: 2, lumaSrc: 300, nSrc: 60, encWait: 50, setup: 40, decWait: 10, lumaDec: 100, nDec: 30, ssim: 30, lumaLive: 400, nLive: 60, ssimLive: 80, liveTail: 70, liveOff: '' };
  const l = timingLine(T, 2000, 2);
  assert.match(l, /^prove: tempi 2\.00 s per 2 segmenti · estrazione 1\.20 s \(120 frame, 2 player/);
  assert.match(l, /misura in diretta: luma 0\.40 s \(60\) \+ SSIM 0\.08 s, coda 0\.07 s/);
  assert.match(l, /altro 0\.20 s$/);
});

// createTrialDeps con encoder/decoder/canvas finti: la misura in diretta dà gli stessi ssimDb della misura dopo
function fakeWorld({ decFail = false } = {}) {
  const lumaOf = (id, noise) => { const d = new Float32Array(16 * 16); for (let i = 0; i < d.length; i++) d[i] = 100 + ((i * 7 + id * 13) % 50) + (noise ? ((i * 31 + id) % 5) - 2 : 0); return { data: d, width: 16, height: 16 }; };
  const mkFrame = (id, noise) => ({ id, noise, closed: false, close() { this.closed = true; } });
  const made = []; const decoders = [];
  const makeEncoder = ({ bitrate, onChunk }) => { let first = true; const q = []; return {
    encode(vf) { const c = { byteLength: Math.round(bitrate / 8 / 60), id: vf.id, noise: bitrate < 6e6 }; const meta = first ? { decoderConfig: { codec: 'fake' } } : undefined; first = false; q.push(Promise.resolve().then(() => onChunk(c, meta))); },
    async drain() { await Promise.all(q); }, async flush() { await Promise.all(q); }, close() {} }; };
  const makeDecoder = ({ output, error }) => { if (decFail) throw new Error('decoder non disponibile'); const d = { state: 'unconfigured', q: [], configure() { d.state = 'configured'; },
    decode(c) { d.q.push(Promise.resolve().then(() => output(mkFrame(c.id, c.noise)))); }, async flush() { await Promise.all(d.q); }, close() { d.state = 'closed'; } }; decoders.push(d); return d; };
  const decodeFn = async (config, chunks, onFrame) => { let i = 0; for (const c of chunks) { const f = mkFrame(c.id, c.noise); await onFrame(f, i++); f.close(); } return i; };
  const frameSource = async function* (a, b) { for (let i = a; i < b; i++) { const f = mkFrame(i, false); made.push(f); yield f; } };
  const fr = Array.from({ length: 120 }, (_, i) => ({ ts: i / 60, dur: 1 / 60 }));
  const common = { W: 32, H: 32, frames: fr, frameSource, makeEncoder, makeDecoder, decodeFn, lumaFn: (f) => lumaOf(f.id, f.noise), framerate: 60 };
  return { common, made, decoders };
}

test('createTrialDeps: live measurement = after-the-fact measurement, frames closed, chunks freed, timing filled', async () => {
  const w = { startIdx: 30, endIdx: 90 };
  const A = fakeWorld(), live = createTrialDeps({ ...A.common });
  const outL = await live.encodeTrial(w, [4e6, 8e6], { stream: [true, false] });
  assert.ok(Array.isArray(outL[0].dbs) && outL[0].dbs.length === 30, 'streamed rate has dbs');
  assert.equal(outL[0].encoded.chunks.length, 0, 'chunks freed after a live measurement');
  assert.equal(outL[1].dbs, undefined); assert.equal(outL[1].encoded.chunks.length, 60);
  const later = await live.measure(w, outL[1].encoded);
  const B = fakeWorld(), seq = createTrialDeps({ ...B.common, live: false });
  const outS = await seq.encodeTrial(w, [4e6, 8e6], { stream: [true, false] });
  assert.equal(outS[0].dbs, undefined);
  const m0 = await seq.measure(w, outS[0].encoded), m1 = await seq.measure(w, outS[1].encoded);
  assert.deepEqual(outL[0].dbs, m0); assert.deepEqual(later, m1);
  assert.ok(m0.every((x) => x < 60) && m1.every((x) => x === 60), 'noisy low rate < identical high rate');
  assert.ok(A.made.every((f) => f.closed), 'every source frame closed');
  const T = live.timing(); assert.equal(T.frames, 60); assert.equal(T.nSrc, 30); assert.equal(T.nLive, 30); assert.equal(T.nDec, 30);
  // second round on the same window reuses the source luma cache and can stream too
  const r2 = await live.encodeTrial(w, [6e6], { stream: [true] }); assert.equal(r2[0].dbs.length, 30); assert.equal(live.timing().nSrc, 30);
});

test('createTrialDeps: a decoder that cannot be created switches the live measurement off and falls back to measure()', async () => {
  const A = fakeWorld({ decFail: true }), d = createTrialDeps({ ...A.common });
  const out = await d.encodeTrial({ startIdx: 0, endIdx: 60 }, [4e6], { stream: [true] });
  assert.equal(out[0].dbs, undefined); assert.equal(out[0].encoded.chunks.length, 60);
  assert.equal((await d.measure({ startIdx: 0, endIdx: 60 }, out[0].encoded)).length, 30);
  assert.match(d.timing().liveOff, /decoder non disponibile/);
  const res = await searchBitrate({ trialWindow: { startIdx: 0, endIdx: 60, srcBitrate: 20e6 }, prior: 8e6 }, d, { maxBitrate: 8e6 });
  assert.ok(res.stats.measures >= 1 && res.stats.streamed === 0);
});
