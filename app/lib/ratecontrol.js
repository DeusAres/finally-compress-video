// Closed-loop per-scene bitrate search (research/12).
//
// Safari's HEVC encoder (VideoToolbox realtime via WebCodecs) has no quantizer: the only quality
// lever is the average `bitrate`, changeable on the fly with configure() (no keyframe, same hvcC).
// So, per segment: trial-encode a short contiguous window at 1–2 bitrates with a SEPARATE encoder,
// re-decode, measure (quality.js ssimDb vs source), map to estimated VMAF, interpolate in log-rate
// and pick the lowest bitrate whose estimate clears target + margin (and a low-percentile guard).
// The final encode then calls configure({bitrate}) + keyFrame at each segment start.
//
// Everything browser-dependent is INJECTED (deps), so this module runs in Node with stubs
// (app/lib/ratecontrol.test.mjs). No WebCodecs/DOM access here.

import { segmentScenes, pickTrialWindow } from './scenes.js?v=0.34.1';
import { DEFAULT_CALIBRATION, pool, estimateVmaf } from './quality.js?v=0.34.1';

export const DEFAULTS = Object.freeze({
  targetVmaf: 88,        // user decision 2026-11-19 (BIBBIA §12): ≈ the verified 8 Mbps file
  marginSd: 1,           // safety margin, in residual s.d. of the calibration (≈ +1.5 VMAF)
  lowVmaf: 72,           // guard on the 5th-percentile frame (8 Mbps file: p5 73.0)
  minBitrate: 2e6, maxBitrate: 20e6,
  trialSec: 1.0,         // trial window length (VT rate control needs ~1 s to settle)
  trialPick: 'center',   // 'center' | 'max' (highest source bitrate), see scenes.pickTrialWindow
  budget: 0.4,           // trial frames (counted once per round) ≤ budget × clip frames; with 2–4 s
                         // segments and 1 s windows, 0.4 tests every segment of a typical clip (≈ 1/3)
  untestedSafety: 1.2,   // extra factor on prior×correction for segments left without a trial
  maxRounds: 2,          // round 1: two bitrates in parallel; round 2: one refinement if extrapolated
  bracket: 1.3,          // round-1 bitrates = prior / bracket, prior × bracket
  slopePerDoubling: 10,  // VMAF points per ×2 bitrate, used only for extrapolation (IMG_7440: 9.6–11.3)
  // prior: needed bitrate ≈ k · srcBitrate^e (bit/s), fitted by tools/lab/calibrate_quality.mjs
  priorModel: { k: 0.4, e: 1.0 },
  segment: { minSec: 2, maxSec: 4 },
  calibration: DEFAULT_CALIBRATION,
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const log2 = Math.log2;

/** Prior guess of the bitrate a window needs, from its source (camera) bitrate. */
export function predictBitrate(srcBitrate, o = DEFAULTS) {
  const { k, e } = o.priorModel ?? DEFAULTS.priorModel;
  return clamp(k * Math.pow(srcBitrate, e), o.minBitrate ?? DEFAULTS.minBitrate, o.maxBitrate ?? DEFAULTS.maxBitrate);
}

/**
 * Plan segments, trial windows and which segments get a trial under the time budget.
 * @param {{ts:number,dur:number}[]} frames   presentable frames, presentation order (index.html `frames`, seconds)
 * @param {{size:number,key:boolean}[]} sourcePackets   same order/length as frames (Mediabunny metadataOnly)
 * @param {object} [opts]  overrides of DEFAULTS; opts.lumaDiff optional per-frame series for cuts
 * @returns {{segments: Array<{startIdx,endIdx,complexity,srcBitrate,duration,cutAtStart,trialWindow,prior,trial:boolean}>,
 *            trialFrames:number, budgetFrames:number}}
 */
export function planSegments(frames, sourcePackets, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (frames.length !== sourcePackets.length) throw new Error('frames and sourcePackets must be aligned');
  const pk = sourcePackets.map((p, i) => ({ size: p.size, key: !!p.key, dur: frames[i].dur }));
  const segs = segmentScenes(pk, { ...o.segment, lumaDiff: opts.lumaDiff });
  const segments = segs.map((s) => {
    const trialWindow = pickTrialWindow(pk, s, o.trialSec, o.trialPick);
    return { ...s, trialWindow, prior: predictBitrate(trialWindow?.srcBitrate ?? s.srcBitrate, o), trial: false };
  });
  // Budget: each tested segment costs 1 window (round-1 bitrates run in parallel from the same
  // frames); a refinement round only runs while budget is left (runSearch). Prefer long segments
  // (they weigh most on file size); always test at least one if the clip is ≥ 3 s, to learn the
  // clip-level correction applied to untested segments.
  const N = frames.length, budgetFrames = Math.floor(o.budget * N);
  const expRounds = 1;
  let used = 0;
  const order = [...segments].sort((a, b) => b.duration - a.duration);
  const clipSec = frames.reduce((s, f) => s + f.dur, 0);
  for (const s of order) {
    const w = s.trialWindow ? s.trialWindow.endIdx - s.trialWindow.startIdx : 0;
    if (!w) continue;
    const cost = w * expRounds;
    if (used + cost <= budgetFrames || (used === 0 && clipSec >= 3)) { s.trial = true; used += cost; }
  }
  return { segments, trialFrames: Math.round(used), budgetFrames };
}

/** Linear interpolation/extrapolation in log2(bitrate) of the bitrate where q(b) reaches t. */
export function solveRate(points, t, slopePerDoubling = DEFAULTS.slopePerDoubling) {
  const p = [...points].sort((a, b) => a.bitrate - b.bitrate);
  if (!p.length) return NaN;
  if (p.length === 1) return p[0].bitrate * 2 ** ((t - p[0].q) / slopePerDoubling);
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i], b = p[i + 1];
    if ((a.q - t) * (b.q - t) <= 0 && a.q !== b.q) return 2 ** (log2(a.bitrate) + (t - a.q) / (b.q - a.q) * (log2(b.bitrate) - log2(a.bitrate)));
  }
  // outside: extrapolate from the nearest end with the measured slope, kept within a plausible range
  const lo = t < p[0].q, a = lo ? p[0] : p[p.length - 2], b = lo ? p[1] : p[p.length - 1];
  let s = (b.q - a.q) / Math.max(1e-6, log2(b.bitrate) - log2(a.bitrate));
  s = clamp(Number.isFinite(s) ? s : slopePerDoubling, slopePerDoubling * 0.5, slopePerDoubling * 2);
  const ref = lo ? p[0] : p[p.length - 1];
  return ref.bitrate * 2 ** ((t - ref.q) / s);
}

/**
 * Search the minimum bitrate for one segment.
 * deps (injected, browser implementations described in docs/research/12 §6):
 *   encodeTrial(window, bitrates[]) → Promise<[{bitrate, bytes, encoded}]>
 *       encode frames [window.startIdx, window.endIdx) once per bitrate with a separate
 *       VideoEncoder (first frame keyFrame), ideally all bitrates in parallel from the same frames.
 *   measure(window, encoded) → Promise<number[]>   per-frame ssimDb vs source (quality.frameScore().db)
 *   (decodeTrial is folded into measure: measure decodes `encoded` itself.)
 * @returns {{bitrate:number, points:Array, rounds:number, reason:string, est:{mean,low}}}
 */
export async function searchBitrate(segment, deps, opts = {}) {
  const o = { ...DEFAULTS, ...opts }, cal = o.calibration;
  const w = segment.trialWindow;
  const tMean = o.targetVmaf + o.marginSd * cal.sd, tLow = o.lowVmaf + o.marginSd * cal.sdLow;
  const prior = clamp(opts.priorBitrate ?? segment.prior ?? predictBitrate(w.srcBitrate, o), o.minBitrate, o.maxBitrate);
  const points = [];
  const run = async (rates) => {
    rates = [...new Set(rates.map((r) => Math.round(clamp(r, o.minBitrate, o.maxBitrate) / 1e4) * 1e4))]
      .filter((r) => !points.some((p) => Math.abs(p.bitrate - r) / r < 0.03));
    if (!rates.length) return;
    const enc = await deps.encodeTrial(w, rates);
    for (const e of enc) {
      const dbs = await deps.measure(w, e.encoded);
      const pooled = pool(dbs), est = estimateVmaf(pooled, cal);
      points.push({ bitrate: e.bitrate, requested: e.requested ?? e.bitrate, bytes: e.bytes, pooled, q: est.mean, qLow: est.low });
    }
  };
  const need = () => {
    const m = solveRate(points.map((p) => ({ bitrate: p.bitrate, q: p.q })), tMean, o.slopePerDoubling);
    const l = solveRate(points.map((p) => ({ bitrate: p.bitrate, q: p.qLow })), tLow, o.slopePerDoubling);
    return Math.max(m, l);
  };
  await run([prior / o.bracket, prior * o.bracket]);
  let rounds = 1, b = need();
  const lo = Math.min(...points.map((p) => p.bitrate)), hi = Math.max(...points.map((p) => p.bitrate));
  // Refine once if the answer was extrapolated well outside the tested bracket (and is not clamped).
  if (rounds < o.maxRounds && (b > hi * 1.15 || b < lo / 1.15) && b > o.minBitrate && b < o.maxBitrate) {
    await run([b]); rounds++; b = need();
  }
  const reason = b >= o.maxBitrate ? 'clamped-max' : b <= o.minBitrate ? 'clamped-min' : 'searched';
  const bitrate = Math.round(clamp(b, o.minBitrate, o.maxBitrate) / 1e4) * 1e4;
  // estimate at the chosen rate (log-linear between the points) for logging
  const at = (key) => { const pts = points.map((p) => ({ x: log2(p.bitrate), y: p[key] })).sort((a, c) => a.x - c.x); const x = log2(bitrate);
    if (pts.length === 1) return pts[0].y + (x - pts[0].x) * o.slopePerDoubling;
    let i = 0; while (i < pts.length - 2 && x > pts[i + 1].x) i++; // interpolate, or extrapolate from the nearest pair
    return pts[i].y + (x - pts[i].x) / (pts[i + 1].x - pts[i].x) * (pts[i + 1].y - pts[i].y); };
  return { bitrate, points, rounds, reason, est: { mean: at('q'), low: at('qLow') }, prior };
}

/**
 * Run the search over a plan. Tested segments get their searched bitrate; untested ones get their
 * prior × clip correction learned on the tested ones (geometric mean of searched/prior, + 1 s.d.)
 * × untestedSafety (simulation on IMG_7440: an untested segment at prior×mean correction fell to
 * VMAF 82 — inside a clip the source bitrate does not predict the need, so untested = risky).
 * onProgress?(i, segment, result) is called after each tested segment.
 * @returns {{segments: Array<segment & {bitrate:number, searched?:object}>, correction:number}}
 */
export async function runSearch(plan, deps, opts = {}, onProgress) {
  const o = { ...DEFAULTS, ...opts };
  const segs = plan.segments.map((s) => ({ ...s }));
  const logs = [];
  let left = (plan.budgetFrames ?? Infinity) - (plan.trialFrames ?? 0);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]; if (!s.trial) continue;
    const wlen = s.trialWindow.endIdx - s.trialWindow.startIdx;
    const r = await searchBitrate(s, deps, { ...o, maxRounds: left >= wlen ? o.maxRounds : 1 });
    if (r.rounds > 1) left -= wlen * (r.rounds - 1);
    s.bitrate = r.bitrate; s.searched = r;
    if (r.reason === 'searched') logs.push(Math.log(r.bitrate / r.prior));
    onProgress?.(i, s, r);
  }
  // conservative clip correction: geometric mean of searched/prior, plus one s.d. when ≥ 2 trials
  const m = logs.length ? logs.reduce((a, b) => a + b, 0) / logs.length : 0;
  const sd = logs.length > 1 ? Math.sqrt(logs.reduce((a, b) => a + (b - m) ** 2, 0) / (logs.length - 1)) : 0;
  const correction = Math.exp(m + sd);
  for (const s of segs) if (!s.trial) s.bitrate = Math.round(clamp(s.prior * correction * o.untestedSafety, o.minBitrate, o.maxBitrate) / 1e4) * 1e4;
  return { segments: segs, correction };
}

/**
 * Turn the searched segments into the per-frame control the final encode needs.
 * Returns a function ctl(i) → {keyFrame:boolean, bitrate:number|null}: bitrate is non-null only at
 * a segment start (call enc.setBitrate(bitrate) BEFORE enc.encode(frame, keyFrame)).
 * gopFrames: periodic keyframes inside long segments (index.html "Keyframe ogni"), counted from
 * each segment start. minChangeRatio: skip configure() if the change is < 8 % (prior art, BIBBIA §8)
 * — the keyframe at the scene boundary is kept anyway.
 */
export function encodeSchedule(segments, { gopFrames = 240, minChangeRatio = 0.08 } = {}) {
  const starts = new Map(); let last = null;
  for (const s of segments) {
    const change = last == null || Math.abs(s.bitrate - last) / last >= minChangeRatio;
    starts.set(s.startIdx, { seg: s, bitrate: change ? s.bitrate : null });
    if (change) last = s.bitrate;
  }
  let segStart = 0;
  return (i) => {
    const st = starts.get(i);
    if (st) { segStart = i; return { keyFrame: true, bitrate: st.bitrate }; }
    return { keyFrame: (i - segStart) % gopFrames === 0, bitrate: null };
  };
}

/** Expected average bitrate (bit/s) of a plan, duration-weighted — for the UI estimate. */
export function expectedBitrate(segments) {
  let b = 0, d = 0; for (const s of segments) { b += s.bitrate * s.duration; d += s.duration; }
  return d ? b / d : 0;
}
