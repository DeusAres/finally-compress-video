// Lightweight full-reference quality metric for the closed-loop bitrate search (research/12).
//
// The CORE is pure JS on plain luma arrays, so the very same code runs in the browser (iPhone)
// and in Node for calibration (tools/lab/calibrate_quality.mjs). Browser-only helpers at the
// bottom touch WebCodecs / canvas globals only inside their bodies (import is safe in Node).
//
// Metric chosen (see docs/research/12 for the numbers): SSIM on the luma plane, 2× box-downsampled
// (1080×1920 → 540×960), x264-style 8×8 windows on a 4-pixel grid, expressed in dB
// (ssimDb = −10·log10(1 − SSIM)), pooled per segment as the mean of per-frame dB.
// A linear map ssimDb → VMAF (vmaf_v0.6.1, as tools/lab/vmaf_score.sh) is fitted on real
// Safari/VideoToolbox outputs; see DEFAULT_CALIBRATION.
//
// Luma convention: 8-bit code values, LIMITED range as stored in the bitstream (Y' 16..235),
// i.e. exactly the Y plane that VideoDecoder returns (NV12 8-bit on Safari 27, research/02 §10 run 4).
// For 10-bit planes (Node calibration) the conversion is round(Y10 / 4) — see lumaFromPlane.

// ---------------------------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------------------------

/**
 * Box-downsample a luma plane by an integer factor into a Float32Array (8-bit scale).
 * @param {ArrayLike<number>} plane  Y samples (Uint8Array / Uint8ClampedArray / Uint16Array …)
 * @param {number} width  @param {number} height  @param {number} [stride=width] samples per row
 * @param {{factor?:number, bitDepth?:number, offset?:number}} [o]
 *   factor: 1|2|4… (default 2); bitDepth: 8 or 10 (10 → values rounded to 8-bit like a
 *   10→8 decoder: (y+2)>>2, clamped 255); offset: index of the first sample of the plane.
 * @returns {{data:Float32Array,width:number,height:number}}
 */
export function lumaFromPlane(plane, width, height, stride = width, o = {}) {
  const f = o.factor ?? 2, off = o.offset ?? 0, bd = o.bitDepth ?? 8;
  const w = Math.floor(width / f), h = Math.floor(height / f), out = new Float32Array(w * h);
  const sh = bd - 8, rnd = sh > 0 ? 1 << (sh - 1) : 0, inv = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        let p = off + (y * f + dy) * stride + x * f;
        for (let dx = 0; dx < f; dx++, p++) {
          let v = plane[p];
          if (sh > 0) { v = (v + rnd) >> sh; if (v > 255) v = 255; }
          s += v;
        }
      }
      out[y * w + x] = s * inv;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Luma from RGBA pixels (canvas getImageData), optional box downsample.
 * weights: BT.2020 [0.2627,0.6780,0.0593] (default) or BT.709 [0.2126,0.7152,0.0722].
 * toLimited (default true): maps full-range Y' 0..255 to 16..235 so it is comparable with a
 * decoder Y plane. Only use it when BOTH sides of a comparison come from the same canvas path.
 */
export function lumaFromRGBA(rgba, width, height, o = {}) {
  const [kr, kg, kb] = o.weights ?? [0.2627, 0.6780, 0.0593];
  const lim = o.toLimited ?? true, y = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < y.length; i++, j += 4) {
    const v = kr * rgba[j] + kg * rgba[j + 1] + kb * rgba[j + 2];
    y[i] = lim ? 16 + v * (219 / 255) : v;
  }
  return lumaFromPlane(y, width, height, width, { factor: o.factor ?? 1 });
}

/** Rotate a luma image by 0/90/180/270° clockwise (VideoDecoder frames are not rotated; <video> frames are). */
export function rotateLuma({ data, width, height }, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return { data, width, height };
  const out = new Float32Array(data.length);
  if (d === 180) { for (let i = 0, n = data.length; i < n; i++) out[n - 1 - i] = data[i]; return { data: out, width, height }; }
  const W = height, H = width; // swapped
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = data[y * width + x];
    if (d === 90) out[x * W + (height - 1 - y)] = v;      // (x,y) → (H-1-y, x)
    else out[(width - 1 - x) * W + y] = v;                 // 270
  }
  return { data: out, width: W, height: H };
}

const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;

/**
 * SSIM, x264/libvpx style: sums over 4×4 blocks, SSIM evaluated on 8×8 windows (2×2 blocks)
 * on a 4-pixel grid. ~6 ops/pixel → ~2–4 ms for 540×960 in JS on a phone-class CPU.
 * Returns mean SSIM and mean contrast-structure term (cs, used by MS-SSIM).
 */
export function ssim(a, b, width, height) {
  const bw = width >> 2, bh = height >> 2;
  if (bw < 2 || bh < 2) return { ssim: 1, cs: 1 };
  // per 4×4 block: sum a, sum b, sum a², sum b², sum ab
  const sa = new Float64Array(bw * bh), sb = new Float64Array(bw * bh), saa = new Float64Array(bw * bh),
    sbb = new Float64Array(bw * bh), sab = new Float64Array(bw * bh);
  for (let y = 0; y < bh * 4; y++) {
    const row = y * width, brow = (y >> 2) * bw;
    for (let x = 0; x < bw * 4; x++) {
      const p = a[row + x], q = b[row + x], k = brow + (x >> 2);
      sa[k] += p; sb[k] += q; saa[k] += p * p; sbb[k] += q * q; sab[k] += p * q;
    }
  }
  let accS = 0, accC = 0, n = 0;
  const N = 64, iN = 1 / N, iN1 = 1 / (N - 1);
  for (let y = 0; y < bh - 1; y++) for (let x = 0; x < bw - 1; x++) {
    const k0 = y * bw + x, k1 = k0 + 1, k2 = k0 + bw, k3 = k2 + 1;
    const A = sa[k0] + sa[k1] + sa[k2] + sa[k3], B = sb[k0] + sb[k1] + sb[k2] + sb[k3];
    const AA = saa[k0] + saa[k1] + saa[k2] + saa[k3], BB = sbb[k0] + sbb[k1] + sbb[k2] + sbb[k3];
    const AB = sab[k0] + sab[k1] + sab[k2] + sab[k3];
    const ma = A * iN, mb = B * iN;
    const va = (AA - A * ma) * iN1, vb = (BB - B * mb) * iN1, cov = (AB - A * mb) * iN1;
    const cs = (2 * cov + C2) / (va + vb + C2);
    accC += cs; accS += ((2 * ma * mb + C1) / (ma * ma + mb * mb + C1)) * cs; n++;
  }
  return { ssim: accS / n, cs: accC / n };
}

/** 2× box downsample (for MS-SSIM pyramids). */
export function half(data, width, height) {
  const w = width >> 1, h = height >> 1, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = 2 * y * width + 2 * x;
    out[y * w + x] = (data[p] + data[p + 1] + data[p + width] + data[p + width + 1]) * 0.25;
  }
  return { data: out, width: w, height: h };
}

/** MS-SSIM (Wang 2003 weights, renormalised to `scales`), box pyramid. */
export function msssim(a, b, width, height, scales = 3) {
  const Wt = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333].slice(0, scales);
  const sum = Wt.reduce((s, x) => s + x, 0);
  let A = { data: a, width, height }, B = { data: b, width, height }, v = 1;
  for (let s = 0; s < scales; s++) {
    const r = ssim(A.data, B.data, A.width, A.height);
    const term = s === scales - 1 ? r.ssim : r.cs;
    v *= Math.pow(Math.max(term, 1e-6), Wt[s] / sum);
    if (s < scales - 1) { A = half(A.data, A.width, A.height); B = half(B.data, B.width, B.height); }
  }
  return v;
}

/** PSNR on 8-bit scale. */
export function psnr(a, b) {
  let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  const mse = s / a.length; return mse <= 1e-10 ? 100 : 10 * Math.log10(65025 / mse);
}

/** SSIM in dB: −10·log10(1−SSIM), capped at 60 dB. Roughly linear in VMAF over the useful range. */
export const toDb = (s) => (s >= 1 - 1e-6 ? 60 : -10 * Math.log10(1 - s));

/**
 * Per-frame score with the chosen metric. `ref`/`dist` are outputs of lumaFromPlane/lumaFromRGBA
 * (same size, same pipeline!). Returns { db, ssim } — db is what the calibration maps to VMAF.
 */
export function frameScore(ref, dist) {
  if (ref.width !== dist.width || ref.height !== dist.height) throw new Error(`size mismatch ${ref.width}×${ref.height} vs ${dist.width}×${dist.height}`);
  const s = ssim(ref.data, dist.data, ref.width, ref.height).ssim;
  return { ssim: s, db: toDb(s) };
}

/** Sorted-quantile helper (linear interpolation). */
export function quantile(values, q) {
  const v = Float64Array.from(values).sort(); if (!v.length) return NaN;
  const p = (v.length - 1) * q, i = Math.floor(p), f = p - i;
  return i + 1 < v.length ? v[i] * (1 - f) + v[i + 1] * f : v[i];
}

/** Pool per-frame dB scores of a segment/trial: mean, low percentile, min. */
export function pool(dbs, pLow = 0.05) {
  let s = 0; for (const x of dbs) s += x;
  return { mean: s / dbs.length, low: quantile(dbs, pLow), min: Math.min(...dbs), n: dbs.length };
}

/**
 * Calibration ssimDb → VMAF (vmaf_v0.6.1), fitted by tools/lab/calibrate_quality.mjs on IMG_7440
 * (real app outputs 4/6/8/10/12 Mbps, v0.13, vs original), 1.0 s segments.
 *   vmaf ≈ a + b·ssimDb   (segment means; residual sd `sd`)
 * low: same for the 5th-percentile frame (vmaf_p5 vs ssimDb p5) — used as a guard.
 * Re-run the script after adding clips and paste the printed object here.
 */
export const DEFAULT_CALIBRATION = Object.freeze({
  metric: 'ssimDb', factor: 2, segmentSec: 1.0, source: 'IMG_7440 (1 clip, 5 bitrates)',
  a: -51.53, b: 9.592, sd: 1.54,          // mean:  vmaf ≈ a + b·db
  aLow: -55.47, bLow: 9.884, sdLow: 2.9,  // p5:    vmaf_p5 ≈ aLow + bLow·db_p5
  plcc: 0.968, srocc: 0.968,
});

/** Estimated VMAF from a pooled score ({mean, low}) using a calibration. */
export function estimateVmaf(pooled, cal = DEFAULT_CALIBRATION) {
  return { mean: cal.a + cal.b * pooled.mean, low: cal.aLow + cal.bLow * pooled.low };
}

/** ssimDb needed for a target VMAF, with a safety margin of k residual s.d. (default k=1). */
export function dbForVmaf(vmaf, cal = DEFAULT_CALIBRATION, k = 1) {
  return (vmaf + k * cal.sd - cal.a) / cal.b;
}
export function dbLowForVmaf(vmafLow, cal = DEFAULT_CALIBRATION, k = 1) {
  return (vmafLow + k * cal.sdLow - cal.aLow) / cal.bLow;
}

// ---------------------------------------------------------------------------------------------
// Browser helpers (WebCodecs / canvas). Not executed in Node.
// ---------------------------------------------------------------------------------------------

/**
 * Luma of a decoded VideoFrame (VideoDecoder output, NV12/I420 8-bit on Safari 27) with no colour
 * conversion: copies only the Y plane of the visible rect. Returns null if the frame has no
 * readable format (native <video> frames: format null) → use lumaViaCanvas instead.
 * Does NOT close the frame.
 */
export async function lumaFromDecodedFrame(frame, { factor = 2, rotation = 0 } = {}) {
  const fmt = frame.format;
  if (!fmt || !/^(NV12|I420|I420A|I422|I444)$/.test(fmt)) return null;
  const r = frame.visibleRect, rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  const buf = new Uint8Array(frame.allocationSize({ rect }));
  const layout = await frame.copyTo(buf, { rect });
  const l = lumaFromPlane(buf, rect.width, rect.height, layout[0].stride, { factor, offset: layout[0].offset });
  return rotation ? rotateLuma(l, rotation) : l;
}

/**
 * Fallback: luma through a 2D canvas (works with native frames, format null). The browser applies
 * its own YCbCr→RGB (and possibly HLG tone mapping) — comparable ONLY with another frame that went
 * through the same function. Downscale is done by drawImage (bilinear-ish), not by a box filter.
 * ctx: an OffscreenCanvasRenderingContext2D of size width×height ({willReadFrequently:true}).
 */
export function lumaViaCanvas(frame, ctx, { weights } = {}) {
  const { width, height } = ctx.canvas;
  ctx.drawImage(frame, 0, 0, width, height);
  const px = ctx.getImageData(0, 0, width, height).data;
  return lumaFromRGBA(px, width, height, { weights, factor: 1 });
}

/**
 * Decode a list of EncodedVideoChunks (first must be a key chunk) and call onFrame(frame, index)
 * for each output, in order. Used for the trial re-decode and for decoding source packets.
 * onFrame may be async; the frame is closed after it resolves.
 */
export async function decodeChunks(config, chunks, onFrame) {
  let err = null, idx = 0, chain = Promise.resolve();
  const dec = new VideoDecoder({
    output: (f) => { const i = idx++; chain = chain.then(() => onFrame(f, i)).finally(() => f.close()); },
    error: (e) => { err = e; },
  });
  dec.configure(config);
  for (const c of chunks) {
    if (err) break;
    dec.decode(c);
    if (dec.decodeQueueSize > 8) await new Promise((r) => dec.addEventListener('dequeue', r, { once: true }));
  }
  await dec.flush().catch((e) => { err ??= e; });
  await chain; dec.close();
  if (err) throw err;
  return idx;
}
