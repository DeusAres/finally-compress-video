// Scene / segment planning from cheap information (research/12).
//
// Input is what the app already has after demux with Mediabunny `metadataOnly`: per-frame packet
// size, key flag and duration, in PRESENTATION order, for the presentable frames only (ts ≥ 0) —
// i.e. the same `frames` array index.html encodes (frame index = encoder input index).
// Optionally a per-frame luma-difference series (e.g. mean |ΔY| on a tiny thumbnail) to sharpen cuts.
//
// Why packet sizes: the iPhone camera encoder is itself a rate-controlled HEVC encoder at high
// bitrate; the bits it spent on a stretch of video are a good proxy for that stretch's coding
// complexity (motion + texture + noise). iPhone keyframes are periodic (every ~28 frames on
// IMG_7440), so we use whole source GOPs as the atomic unit: a GOP's bitrate is stable, while
// single-frame sizes swing ×10 between I/P/B.
//
// Pure module, no browser APIs.

/**
 * @typedef {{size:number, key:boolean, dur:number}} Pkt   dur in seconds
 * @typedef {{startIdx:number, endIdx:number, srcBitrate:number, duration:number}} Unit   endIdx exclusive
 */

function unitOf(packets, s, e) {
  let bytes = 0, dur = 0;
  for (let i = s; i < e; i++) { bytes += packets[i].size; dur += packets[i].dur; }
  return { startIdx: s, endIdx: e, srcBitrate: dur > 0 ? bytes * 8 / dur : 0, duration: dur };
}

/** Split frames into source-GOP units (boundary at every key packet) with their bitrate. */
export function sourceBitrateSeries(packets) {
  const units = []; let s = 0;
  const close = (e) => { if (e > s) units.push(unitOf(packets, s, e)); };
  for (let i = 1; i < packets.length; i++) if (packets[i].key) { close(i); s = i; }
  close(packets.length);
  return units;
}

/**
 * Candidate hard cuts (frame indices) from size spikes of NON-key packets (a scene change coded as
 * P/B costs many more bits than its neighbours) and, if given, from luma-difference spikes.
 */
export function detectCuts(packets, { lumaDiff = null, sizeSpike = 4, diffSpike = 5, window = 15 } = {}) {
  const cuts = new Set(), n = packets.length;
  const localMedian = (arr, i, ok) => {
    const v = []; for (let j = Math.max(0, i - window); j < Math.min(n, i + window + 1); j++) if (j !== i && ok(j)) v.push(arr(j));
    v.sort((a, b) => a - b); return v.length ? v[v.length >> 1] : Infinity;
  };
  for (let i = 1; i < n; i++) {
    if (!packets[i].key) {
      const m = localMedian((j) => packets[j].size, i, (j) => !packets[j].key);
      if (packets[i].size > sizeSpike * m) cuts.add(i);
    }
    if (lumaDiff && lumaDiff[i] != null) {
      const m = localMedian((j) => lumaDiff[j] ?? 0, i, () => true);
      if (lumaDiff[i] > diffSpike * Math.max(m, 0.5)) cuts.add(i);
    }
  }
  return [...cuts].sort((a, b) => a - b);
}

/**
 * Segment the clip into scenes of minSec..maxSec seconds whose source bitrate is homogeneous.
 * Dynamic programming over source-GOP units: minimise Σ (within-segment variance of log rate · dur)
 * + penalty per segment, with forced boundaries at detected cuts (a cut splits its unit).
 *
 * @param {Pkt[]} packets  presentation order, presentable frames only
 * @param {{minSec?:number,maxSec?:number,penalty?:number,lumaDiff?:number[]}} [opts]
 * @returns {{startIdx:number,endIdx:number,complexity:number,srcBitrate:number,duration:number,cutAtStart:boolean}[]}
 *   endIdx exclusive; complexity = segment source bitrate / clip source bitrate (1 = average).
 */
export function segmentScenes(packets, opts = {}) {
  const minSec = opts.minSec ?? 2, maxSec = opts.maxSec ?? 8, penalty = opts.penalty ?? 0.02;
  if (!packets.length) return [];
  const cuts = detectCuts(packets, opts);
  // units: source GOPs, further split at cuts
  let units = sourceBitrateSeries(packets);
  if (cuts.length) {
    const split = [];
    for (const u of units) {
      let s = u.startIdx;
      for (const c of cuts) if (c > s && c < u.endIdx) { split.push(unitOf(packets, s, c)); s = c; }
      split.push(s === u.startIdx ? u : unitOf(packets, s, u.endIdx));
    }
    units = split;
  }
  const isCut = new Set(cuts);
  const n = units.length, total = units.reduce((s, u) => s + u.duration, 0);
  const clipRate = packets.reduce((s, p) => s + p.size, 0) * 8 / Math.max(total, 1e-9);
  if (total <= minSec * 1.5 || n === 1) return [mk(0, n)];

  // prefix sums for O(1) segment cost: weights = duration, values = log rate
  const W = [0], S = [0], Q = [0], D = [0];
  for (const u of units) { const w = u.duration, x = Math.log(Math.max(u.srcBitrate, 1)); W.push(W.at(-1) + w); S.push(S.at(-1) + w * x); Q.push(Q.at(-1) + w * x * x); D.push(D.at(-1) + u.duration); }
  const cost = (i, j) => { const w = W[j] - W[i], s = S[j] - S[i], q = Q[j] - Q[i]; return q - s * s / w; }; // Σw(x−x̄)²
  const best = new Float64Array(n + 1).fill(Infinity), prev = new Int32Array(n + 1).fill(-1); best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const dur = D[j] - D[i];
      if (dur > maxSec && j - i > 1) break;
      // a cut inside (i, j) forbids merging across it
      let crosses = false; for (let k = i + 1; k < j; k++) if (isCut.has(units[k].startIdx)) { crosses = true; break; }
      if (crosses) break;
      const short = dur < minSec && !(i === 0 && j === n);
      const c = best[i] + cost(i, j) + penalty + (short ? 1e3 * (minSec - dur) : 0);
      if (c < best[j]) { best[j] = c; prev[j] = i; }
    }
  }
  const bounds = []; for (let j = n; j > 0; j = prev[j]) bounds.push([prev[j], j]);
  return bounds.reverse().map(([i, j]) => mk(i, j));

  function mk(i, j) {
    const s = units[i].startIdx, e = units[j - 1].endIdx; let b = 0, d = 0;
    for (let k = s; k < e; k++) { b += packets[k].size; d += packets[k].dur; }
    const r = d > 0 ? b * 8 / d : 0;
    return { startIdx: s, endIdx: e, srcBitrate: r, duration: d, complexity: r / clipRate, cutAtStart: isCut.has(s) };
  }
}

/**
 * Pick the trial window inside a segment: the contiguous stretch of ~trialSec, starting on a source
 * key packet when possible, with the HIGHEST source bitrate (worst case → conservative choice).
 * @returns {{startIdx:number,endIdx:number,srcBitrate:number}}
 */
export function pickTrialWindow(packets, seg, trialSec = 1.0) {
  let best = null;
  const starts = [];
  for (let i = seg.startIdx; i < seg.endIdx; i++) if (packets[i].key || i === seg.startIdx) starts.push(i);
  for (const s of starts) {
    let d = 0, b = 0, e = s;
    while (e < seg.endIdx && d < trialSec) { d += packets[e].dur; b += packets[e].size; e++; }
    if (d < trialSec * 0.6 && best) continue; // too short near the end, keep a full one
    const r = b * 8 / Math.max(d, 1e-9);
    if (!best || r > best.srcBitrate) best = { startIdx: s, endIdx: e, srcBitrate: r };
  }
  return best;
}
