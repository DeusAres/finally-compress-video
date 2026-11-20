// Run: node --test app/lib/scenesearch.test.mjs   (pure Node, stubbed encode/measure; no browser)
// Covers the «qualità per scena» wiring (scenesearch.js): plan aligned to export segments, ceiling, resume
// from saved records, fallback on trial errors, per-segment closed-loop controller, summary/log lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSceneSegments, centerWindow, runSceneSearch, sceneSummary, sceneLine, lumaU8FromRGBA } from './scenesearch.js';
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
