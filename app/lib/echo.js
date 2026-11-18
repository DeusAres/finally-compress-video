// Rilevamento e rimozione di un'eco digitale "copia ritardata": y = x + a*x[n-d].
// JS puro (ES2020), nessuna dipendenza. Browser + Node.

// ---------- FFT radix-2 (in place, complessa) ----------
const twCache = new Map();
function twiddles(n) {
  let t = twCache.get(n);
  if (!t) {
    const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, sin };
    twCache.set(n, t);
  }
  return t;
}
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const { cos, sin } = twiddles(n);
  const sgn = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w], wi = sgn * sin[w];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// ---------- utilita ----------
function mono(channels, start, len) {
  const out = new Float64Array(len);
  const nch = channels.length;
  for (let c = 0; c < nch; c++) {
    const ch = channels[c];
    for (let i = 0; i < len; i++) out[i] += ch[start + i] || 0;
  }
  return out;
}
function median(a) {
  const s = Array.from(a).sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length ? (s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
}
// finestre da winLen campioni distribuite uniformemente, al massimo maxSec secondi totali
function pickWindows(total, winLen, maxWin) {
  const nAll = Math.floor(total / winLen);
  if (nAll <= 0) return [];
  const n = Math.min(nAll, maxWin);
  const starts = [];
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : Math.round((i * (nAll - 1)) / (n - 1));
    starts.push(idx * winLen);
  }
  return starts;
}
// autocorrelazione normalizzata r[lag]/r[0] via FFT (zero-padding, niente wrap)
function autocorr(x, maxLag) {
  let n = 1;
  while (n < x.length + maxLag + 1) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im, true);
  const r0 = re[0];
  const out = new Float64Array(maxLag + 1);
  if (r0 > 0) for (let i = 0; i <= maxLag; i++) out[i] = re[i] / r0;
  return out;
}

// ---------- rilevamento ----------
export function detectEcho(channels, sampleRate, opts = {}) {
  const minMs = opts.minMs ?? 5, maxMs = opts.maxMs ?? 120, lobeMs = opts.lobeMs ?? 3;
  const maxSeconds = opts.maxSeconds ?? 30;
  const total = channels[0].length;
  // window: 1 s, shortened for short clips (min 0.4 s) so that >= 3 windows exist (2.5 s clips were missed)
  const winSec = opts.windowSec ?? Math.max(0.4, Math.min(1, total / sampleRate / 4));
  const winLen = Math.round(sampleRate * winSec);
  const lo = Math.max(Math.ceil((Math.max(minMs, lobeMs) * sampleRate) / 1000), 2);
  const hi = Math.floor((maxMs * sampleRate) / 1000);
  const perWindow = [];
  for (const start of pickWindows(total, winLen, maxSeconds)) {
    const x = mono(channels, start, winLen);
    let e = 0;
    for (let i = 0; i < winLen; i++) e += x[i] * x[i];
    if (e / winLen < 1e-9) continue; // finestra (quasi) silenziosa
    // pre-enfasi leggera: toglie la correlazione di bassa frequenza (lobo largo)
    const w = new Float64Array(winLen);
    for (let i = 1; i < winLen; i++) w[i] = x[i] - 0.9 * x[i - 1];
    const r = autocorr(w, hi + 1);
    let best = lo, bv = -Infinity;
    for (let l = lo; l <= hi; l++) if (r[l] > bv) { bv = r[l]; best = l; }
    // interpolazione parabolica
    let frac = 0;
    const a = r[best - 1], b = r[best], c = r[best + 1];
    const den = a - 2 * b + c;
    if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    const lag = best + frac;
    perWindow.push({ start: start / sampleRate, lagSamples: lag, lagMs: (lag * 1000) / sampleRate, rho: bv });
  }
  if (!perWindow.length) return { found: false, delaySamples: NaN, delayMs: NaN, rho: 0, consistency: 0, perWindow };
  const medLag = median(perWindow.map((p) => p.lagSamples));
  const tol = (0.15 * sampleRate) / 1000;
  const inl = perWindow.filter((p) => Math.abs(p.lagSamples - medLag) <= tol);
  const consistency = inl.length / perWindow.length;
  const delaySamples = median(inl.map((p) => p.lagSamples));
  const rho = median(perWindow.map((p) => p.rho));
  const found = perWindow.length >= 3 && consistency >= 0.75 && rho >= 0.15;
  return { found, delaySamples, delayMs: (delaySamples * 1000) / sampleRate, rho, consistency, perWindow };
}

// ---------- rimozione ----------
// x[n] = y[n] - a * x[n-d], d frazionario (interpolazione lineare: guadagno <= 1, quindi stabile per |a|<1)
function softLimit(v) {
  const T = 0.9, av = Math.abs(v);
  if (av <= T) return v;
  const s = v < 0 ? -1 : 1;
  return s * (T + (1 - T) * Math.tanh((av - T) / (1 - T)));
}
export function createEchoRemover({ delaySamples, gain, gainHigh, crossoverHz = 2000, sampleRate = 44100, channels = 1, limiter = true }) {
  if (!(delaySamples >= 2)) throw new Error('delaySamples must be >= 2');
  const clampG = (v) => Math.max(-0.98, Math.min(0.98, v));
  const aLo = clampG(gain), aHi = clampG(gainHigh ?? gain);
  // il ramo di feedback e' aLo*LP(x_d) + aHi*(x_d - LP(x_d)), LP one-pole (guadagno <= 1): stabile se |a|<1
  const k = 1 - Math.exp((-2 * Math.PI * crossoverHz) / sampleRate);
  const D = Math.floor(delaySamples), f = delaySamples - D;
  const size = D + 2;
  const bufs = Array.from({ length: channels }, () => new Float32Array(size));
  const lps = new Float64Array(channels);
  let pos = 0; // indice di scrittura condiviso (tutti i canali avanzano insieme)
  return {
    process(chunk) {
      const len = chunk[0].length;
      const out = chunk.map(() => new Float32Array(len));
      for (let c = 0; c < channels; c++) {
        const buf = bufs[c], inp = chunk[c], o = out[c];
        let p = pos, lp = lps[c];
        for (let i = 0; i < len; i++) {
          let i1 = p - D; if (i1 < 0) i1 += size;
          let i2 = i1 - 1; if (i2 < 0) i2 += size;
          const xd = (1 - f) * buf[i1] + f * buf[i2];
          lp += k * (xd - lp);
          const x = inp[i] - (aLo * lp + aHi * (xd - lp));
          buf[p] = x;
          o[i] = limiter ? softLimit(x) : x;
          if (++p === size) p = 0;
        }
        lps[c] = lp;
        if (c === channels - 1) pos = p;
      }
      return out;
    },
  };
}
export function removeEcho(channels, sampleRate, { delaySamples, gain, gainHigh, crossoverHz, limiter = true }) {
  const r = createEchoRemover({ delaySamples, gain, gainHigh, crossoverHz, sampleRate, channels: channels.length, limiter });
  return r.process(channels);
}

// ---------- stima del guadagno ----------
// correlazione normalizzata del segnale s al lag frazionario d (somma diretta)
function corrAt(s, d) {
  const D = Math.floor(d), f = d - D, n = s.length;
  let num = 0, e0 = 0, e1 = 0;
  for (let i = D + 1; i < n; i++) {
    const v = (1 - f) * s[i - D] + f * s[i - D - 1];
    num += s[i] * v; e0 += s[i] * s[i]; e1 += v * v;
  }
  return num / (Math.sqrt(e0 * e1) + 1e-30);
}
function bands(x, k) {
  const lo = new Float32Array(x.length), hi = new Float32Array(x.length);
  let lp = 0;
  for (let i = 0; i < x.length; i++) { lp += k * (x[i] - lp); lo[i] = lp; hi[i] = x[i] - lp; }
  return { lo, hi };
}
// Stima i guadagni (banda bassa / alta) minimizzando la correlazione residua del segnale corretto
// ai lag d e 2d, per banda. Punto di partenza: soluzione analitica rho = a/(1+a^2).
export function estimateGain(channels, sampleRate, delaySamples, opts = {}) {
  const segLen = Math.round(sampleRate), nSeg = opts.segments ?? 4;
  const crossoverHz = opts.crossoverHz ?? 2000;
  const k = 1 - Math.exp((-2 * Math.PI * crossoverHz) / sampleRate);
  const total = channels[0].length;
  const segs = pickWindows(total, segLen, nSeg).map((s) => Float32Array.from(mono(channels, s, segLen), (v) => v * 0.5));
  if (!segs.length) return { gain: 0, gainHigh: 0, crossoverHz, rhoBefore: 0, rhoAfter: 0 };
  const skip = Math.ceil(delaySamples * 4);
  const ev = (aLo, aHi) => {
    let r = { lo1: 0, lo2: 0, hi1: 0, hi2: 0, full: 0 };
    for (const sg of segs) {
      const x = removeEcho([sg], sampleRate, { delaySamples, gain: aLo, gainHigh: aHi, crossoverHz, limiter: false })[0].subarray(skip);
      const b = bands(x, k);
      r.lo1 += corrAt(b.lo, delaySamples); r.lo2 += corrAt(b.lo, 2 * delaySamples);
      r.hi1 += corrAt(b.hi, delaySamples); r.hi2 += corrAt(b.hi, 2 * delaySamples);
      r.full += corrAt(x, delaySamples);
    }
    for (const key in r) r[key] /= segs.length;
    return r;
  };
  const search = (costFn) => {
    let bestA = 0, bestC = Infinity;
    for (let a = 0; a <= 0.98 + 1e-9; a += 0.02) { const c = costFn(a); if (c < bestC) { bestC = c; bestA = a; } }
    const c0 = bestA;
    for (let a = Math.max(0, c0 - 0.02); a <= Math.min(0.98, c0 + 0.02) + 1e-9; a += 0.005) {
      const c = costFn(a); if (c < bestC) { bestC = c; bestA = a; }
    }
    return bestA;
  };
  const before = ev(0, 0);
  const an = (rho) => { const rc = Math.min(Math.max(rho, 0), 0.49); return rc > 1e-6 ? (1 - Math.sqrt(1 - 4 * rc * rc)) / (2 * rc) : 0; };
  let aLo = an(before.lo1), aHi = an(before.hi1);
  const analytic = { gain: aLo, gainHigh: aHi };
  for (let it = 0; it < 2; it++) {
    aLo = search((a) => { const r = ev(a, aHi); return r.lo1 * r.lo1 + r.lo2 * r.lo2; });
    aHi = search((a) => { const r = ev(aLo, a); return r.hi1 * r.hi1 + r.hi2 * r.hi2; });
  }
  const after = ev(aLo, aHi);
  return { gain: aLo, gainHigh: aHi, crossoverHz, analytic, rhoBefore: before.full, rhoAfter: after.full };
}

// =====================================================================================
// v2: eco con percorso filtrato  y[n] = x[n] + sum_k h[k] x[n-D-k],  k in [-K,K], D = round(delay)
// h FIR centrata stimata ai minimi quadrati (Wiener, regolarizzata) su segnale sbiancato (LPC),
// raffinata per iterazioni (il predittore di Wiener su y e' distorto: a/(1+a^2) invece di a).
// Inverso: 'iir'  x[n] = y[n] - sum h[k] x[n-D-k]           (stabile se max_f|H(f)| < 1)
//          'fir'  Horner a M stadi  x_m = y - H z^-D x_{m-1}  (x_M = y - Hy_d + HHy_2d - ...; sempre stabile)
// ---------------------------------------------------------------------------------------
function acRaw(x, maxLag) {
  let n = 1;
  while (n < x.length + maxLag + 1) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im, true);
  return re.subarray(0, maxLag + 1);
}
function levinson(r, order) {
  const a = new Float64Array(order + 1); a[0] = 1;
  let e = r[0] * (1 + 1e-6) + 1e-30;
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    const prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    e *= 1 - k * k;
  }
  return a;
}
function firApply(x, a) {
  const out = new Float64Array(x.length), p = a.length;
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    for (let i = 0; i < p && i <= n; i++) s += a[i] * x[n - i];
    out[n] = s;
  }
  return out;
}
function solveSPD(A, b, n) { // Cholesky, A riga-maggiore (modificata in place)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      if (i === j) A[i * n + i] = Math.sqrt(Math.max(s, 1e-300));
      else A[i * n + j] = s / A[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= A[i * n + k] * y[k]; y[i] = s / A[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= A[k * n + i] * x[k]; x[i] = s / A[i * n + i]; }
  return x;
}
// max_f |H(f)| con H(f)=sum h[j] e^{-j w j}
export function echoFilterMaxResponse(h) {
  let n = 1; while (n < 8 * h.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let j = 0; j < h.length; j++) re[j] = h[j];
  fft(re, im);
  let m = 0;
  for (let i = 0; i <= n >> 1; i++) m = Math.max(m, Math.hypot(re[i], im[i]));
  return m;
}

// ----- nucleo di filtraggio a blocchi (Float64 interno; stato = storia degli stadi) -----
function makeCore({ D, K, hs, mode, stages, channels }) {
  if (!(D > K + 1)) throw new Error('delay must exceed taps/2');
  const L = D + K, M = mode === 'iir' ? 1 : Math.max(1, stages | 0), rec = mode === 'iir', T = 2 * K + 1;
  const hist = Array.from({ length: channels }, () => Array.from({ length: M + 1 }, () => new Float64Array(L)));
  return {
    run(chunk) {
      const len = chunk[0].length;
      return chunk.map((inp, c) => {
        const h = hs[c], hh = hist[c];
        const ext = [];
        for (let m = 0; m <= M; m++) { const e = new Float64Array(L + len); e.set(hh[m]); ext.push(e); }
        const e0 = ext[0];
        for (let i = 0; i < len; i++) e0[L + i] = inp[i];
        for (let m = 1; m <= M; m++) {
          const dst = ext[m], src = rec ? dst : ext[m - 1];
          for (let i = 0; i < len; i++) {
            const base = L + i - D + K;
            let s = 0;
            for (let j = 0; j < T; j++) s += h[j] * src[base - j];
            dst[L + i] = e0[L + i] - s;
          }
        }
        for (let m = 0; m <= M; m++) hh[m] = ext[m].slice(len);
        return ext[M].subarray(L);
      });
    },
  };
}

export function estimateEchoFilter(channels, sampleRate, delaySamples, opts = {}) {
  const D = Math.round(delaySamples), nch = channels.length;
  let K = ((opts.taps ?? 129) - 1) >> 1;
  K = Math.max(1, Math.min(K, D - 2));
  const T = 2 * K + 1, perChannel = opts.perChannel ?? true;
  const iterations = opts.iterations ?? 5, lambda = opts.lambda ?? 1e-3, maxGain = opts.maxGain ?? 0.9;
  const total = channels[0].length;
  let segLen = Math.round((opts.segSec ?? 1.5) * sampleRate);
  if (total < segLen) segLen = total;
  const zero = () => Array.from({ length: nch }, () => new Float64Array(T));
  if (segLen < 8 * D) return { h: zero(), K, D, taps: T, perChannel, maxResponse: 0, scale: 1, iterations: 0 };
  const starts = pickWindows(total, segLen, opts.segments ?? 5);
  const sig = channels.map((ch) => starts.map((s) => Float64Array.from(ch.subarray(s, s + segLen))));
  // filtro sbiancante LPC (ordine 32) da tutti i segmenti: non cambia h (LTI), ma rende R ~ diagonale
  const rr = new Float64Array(33);
  for (const ch of sig) for (const sg of ch) { const r = acRaw(sg, 32); for (let i = 0; i <= 32; i++) rr[i] += r[i]; }
  const a = levinson(rr, 32);
  const w = sig.map((ch) => ch.map((sg) => firApply(sg, a)));
  const groups = perChannel ? Array.from({ length: nch }, (_, c) => [c]) : [Array.from({ length: nch }, (_, c) => c)];
  const skip = 3 * D + K;
  const hOut = new Array(nch);
  let maxResponse = 0;
  const gh = groups.map((g) => {
    const h = new Float64Array(T);
    for (let it = 0; it < iterations; it++) {
      const r = new Float64Array(D + K + 1);
      for (const c of g) for (const sg of w[c]) {
        let u = sg;
        if (it > 0) u = makeCore({ D, K, hs: [h], mode: 'iir', channels: 1 }).run([sg])[0];
        const ac = acRaw(u.subarray(skip), D + K);
        for (let i = 0; i < r.length; i++) r[i] += ac[i];
      }
      const A = new Float64Array(T * T), b = new Float64Array(T);
      for (let i = 0; i < T; i++) {
        const q = (i - K) / K;
        for (let j = 0; j < T; j++) A[i * T + j] = r[Math.abs(i - j)];
        A[i * T + i] += lambda * r[0] * (1 + 8 * q * q);
        b[i] = r[D + i - K];
      }
      const e = solveSPD(A, b, T);
      for (let i = 0; i < T; i++) h[i] += e[i];
    }
    const mr = echoFilterMaxResponse(h);
    maxResponse = Math.max(maxResponse, mr);
    if (mr > maxGain) { const s = maxGain / mr; for (let i = 0; i < T; i++) h[i] *= s; }
    return h;
  });
  for (let c = 0; c < nch; c++) hOut[c] = gh[perChannel ? c : 0];
  return { h: hOut, K, D, taps: T, perChannel, maxResponse, scale: maxResponse > maxGain ? maxGain / maxResponse : 1, iterations };
}

// h: Float64Array (condivisa) oppure array di Float64Array (una per canale)
export function createEchoRemoverV2({ delaySamples, h, mode = 'iir', stages = 3, channels = 1, limiter = true }) {
  const D = Math.round(delaySamples);
  const hs = Array.from({ length: channels }, (_, c) => (typeof h[0] === 'number' ? h : h[Math.min(c, h.length - 1)]));
  const K = (hs[0].length - 1) >> 1;
  const core = makeCore({ D, K, hs, mode, stages, channels });
  return {
    process(chunk) {
      const o = core.run(chunk);
      return o.map((d) => { const f = new Float32Array(d.length); for (let i = 0; i < d.length; i++) f[i] = limiter ? softLimit(d[i]) : d[i]; return f; });
    },
  };
}
export function removeEchoV2(channels, sampleRate, { delaySamples, h, mode = 'iir', stages = 3, limiter = true }) {
  return createEchoRemoverV2({ delaySamples, h, mode, stages, channels: channels.length, limiter }).process(channels);
}

// ---------- metriche v2 ----------
function biquad(type, fc, sr, x) {
  const w0 = (2 * Math.PI * fc) / sr, al = Math.sin(w0) / (2 * Math.SQRT1_2), cs = Math.cos(w0);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; } else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  const out = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}
export const ECHO_BANDS = [[0, 500], [500, 2000], [2000, 6000], [6000, Infinity]];
export function bandSignal(x, sr, [lo, hi]) {
  let s = x;
  if (lo > 0) s = biquad('hp', lo, sr, biquad('hp', lo, sr, s));
  if (isFinite(hi)) s = biquad('lp', hi, sr, biquad('lp', hi, sr, s));
  return s;
}
// rho medio (su finestre da 1 s) ai lag m*d, m=1..3, per banda; max |rho| entro +-1.5 campioni
export function echoBandRho(channels, sampleRate, delaySamples, { bands = ECHO_BANDS, lags = [1, 2, 3] } = {}) {
  const n = channels[0].length, m = mono(channels, 0, n);
  for (let i = 0; i < n; i++) m[i] *= 0.5;
  const starts = pickWindows(n, sampleRate, 12);
  return bands.map((bd) => {
    const bs = bandSignal(m, sampleRate, bd);
    return lags.map((mult) => {
      let acc = 0, cnt = 0;
      for (const s of starts) {
        const seg = bs.subarray(s, s + sampleRate);
        let best = 0;
        for (let o = -1.5; o <= 1.5; o += 0.5) best = Math.max(best, Math.abs(corrAt(seg, mult * delaySamples + o)));
        acc += best; cnt++;
      }
      return cnt ? acc / cnt : 0;
    });
  });
}
// indice di comb: picco del cepstrum reale (log-spettro medio) al quefrency d / |c| mediano in [0.5d,1.5d]
export function echoCepstrumComb(channels, sampleRate, delaySamples, { frame = 8192 } = {}) {
  const n = channels[0].length, m = mono(channels, 0, n);
  const D = Math.round(delaySamples), logAvg = new Float64Array(frame);
  let nf = 0;
  for (let s = 0; s + frame <= n; s += frame >> 1) {
    const re = new Float64Array(frame), im = new Float64Array(frame);
    let e = 0;
    for (let i = 0; i < frame; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame); re[i] = m[s + i] * w; e += re[i] * re[i]; }
    if (e < 1e-6) continue;
    fft(re, im);
    for (let i = 0; i < frame; i++) logAvg[i] += Math.log(re[i] * re[i] + im[i] * im[i] + 1e-12) * 0.5;
    nf++;
  }
  if (!nf) return { peak: 0, floor: 0, ratio: 0, peak2: 0 };
  const im = new Float64Array(frame);
  for (let i = 0; i < frame; i++) logAvg[i] /= nf;
  fft(logAvg, im, true);
  const pk = (q) => { let b = -Infinity; for (let o = -2; o <= 2; o++) b = Math.max(b, logAvg[q + o]); return b; };
  const fl = [];
  for (let q = Math.floor(0.5 * D); q <= Math.ceil(1.5 * D); q++) if (Math.abs(q - D) > 8) fl.push(Math.abs(logAvg[q]));
  const floor = median(fl), peak = pk(D);
  return { peak, floor, ratio: peak / (floor + 1e-12), peak2: pk(2 * D) };
}

// ======================================================================================
// v3: cancellazione adattiva per bin (STFT) + soppressione dell'eco residua.
//
// Modello per bin: Y(k,t) = X(k,t) + W(k,t) * R(k,t),  R = STFT di r[n] = xhat1[n-D] (D = round(d)),
// dove xhat1 e' l'uscita dello stadio lineare (OLA) gia' pulita => struttura ricorsiva come v2 (IIR).
// Il ritardo frazionario (d - D) e' assorbito dalla fase complessa di W (rampa di fase in k).
// W: LS ricorsivo con memoria esponenziale (RLS scalare per bin) su statistiche S_yr/S_rr mediate
//    in tempo (lambda) e su +-F bin; shrink alla Wiener della coerenza (toglie il bias a coerenza ~0),
//    rilassamento W <- W + mu (W_ls - W), |W| <= maxGain (<0.95), protezione dalla divergenza
//    (se la potenza di E supera 1.5x quella di Y nel bin -> W dimezzata).
// Post-filtro: G = max(Gmin, 1 - beta(f) * Pecho / PE), Pecho = |W|^2 |R|^2 (c1 + c2 (1-gamma_yr^2)) + gamma_er^2 PE,
//    G smussato in frequenza (3 tap) e in tempo (attacco rapido, rilascio lento); beta(f) attivo ~1.8-8 kHz.
// Vincolo: finestra N <= D (il riferimento ritardato e' sempre gia' finalizzato); N = 1024 (D~1841), hop N/4.
// Latenza: STFT con finestra N, hop H = N/4 => latenza N-H campioni (768 @ N=1024, 17.4 ms).
//   Il flusso e' ALLINEATO: l'uscita campione i corrisponde all'ingresso campione i. process() emette i campioni
//   man mano che sono definitivi (cumulativamente `latency` in meno dell'ingresso); flush() emette il resto.
//   Somma di tutte le uscite == numero di campioni in ingresso. removeEchoV3 (batch) = process + flush.
// ======================================================================================
const V3_DEFAULTS = {
  frame: 1024, lambda: 0.97, mu: 0.3, span: 2, maxGain: 0.94, coh0: 0.03, reg: 0.02,
  suppress: true, gMinDb: -12, beta: 1.0, c1: 0.15, c2: 0.5, bandsHz: [1000, 1800, 8000, 12000], tailBeta: 0.25,
  kappa: 1, lamP: 0.99, smoothUp: 0.35, smoothDown: 0.7, limiter: true,
};
function boxSum(src, dst, K, F) {
  let acc = 0;
  for (let i = 0; i <= Math.min(F, K - 1); i++) acc += src[i];
  dst[0] = acc;
  for (let k = 1; k < K; k++) {
    if (k + F < K) acc += src[k + F];
    if (k - F - 1 >= 0) acc -= src[k - F - 1];
    dst[k] = acc;
  }
}
function v3Params(delaySamples, sampleRate, o) {
  const D = Math.round(delaySamples);
  let N = o.frame;
  while (N > D && N > 64) N >>= 1;
  if (!(D >= 64)) throw new Error('delay too short for v3');
  const H = N >> 2, K = (N >> 1) + 1;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const [b0, b1, b2, b3] = o.bandsHz, bw = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const f = (k * sampleRate) / N;
    bw[k] = f < b0 ? 0 : f < b1 ? (f - b0) / (b1 - b0) : f <= b2 ? 1 : f < b3 ? 1 - (1 - o.tailBeta) * ((f - b2) / (b3 - b2)) : o.tailBeta;
  }
  return { D, N, H, K, w, bw, gMin: Math.pow(10, o.gMinDb / 20), o };
}
function v3Channel(P) {
  const { K } = P, f = () => new Float64Array(K);
  return {
    base: 0, cap: 0, inb: new Float64Array(0), o1: new Float64Array(0), o2: new Float64Array(0),
    inEnd: 0, t: 0, fin: 0, emitted: 0,
    Wr: f(), Wi: f(), Sxr: f(), Sxi: f(), Srr: f(), Syy: f(), Ser: f(), Sei: f(), See: f(),
    pe: f(), py: f(), pe2: f(), pr2: f(), Mpe: f(), Mpr: f(), Mpp: f(), Mpx: f(), G: new Float64Array(K).fill(1),
  };
}
function v3Ensure(st, need) {
  if (st.cap >= need) return;
  const cap = Math.max(need, st.cap * 2, 1 << 16);
  for (const k of ['inb', 'o1', 'o2']) { const a = new Float64Array(cap); a.set(st[k]); st[k] = a; }
  st.cap = cap;
}
function v3Frames(P, st, scr) {
  const { N, H, K, D, w, bw, gMin, o } = P, M = N - 1;
  const { re, im, cr, ci, pr, py, bcr, bci, bpr, bpy, Er, Ei, tmp, tmp2 } = scr;
  const lam = o.lambda, a = 1 - lam, F = o.span, lp = o.lamP;
  while (true) {
    const s = st.t * H - (N - H);
    if (s + N > st.inEnd) break;
    v3Ensure(st, s + N - st.base + 1);
    for (let i = 0; i < N; i++) {
      const ai = s + i, ar = ai - D;
      re[i] = (ai >= 0 ? st.inb[ai - st.base] : 0) * w[i];
      im[i] = (ar >= 0 ? st.o1[ar - st.base] : 0) * w[i];
    }
    fft(re, im);
    // separa Y (re) e R (im)
    for (let k = 0; k < K; k++) {
      const m = (N - k) & M, zr = re[k], zi = im[k], mr = re[m], mi = im[m];
      const yr = 0.5 * (zr + mr), yi = 0.5 * (zi - mi), rr = 0.5 * (zi + mi), ri = -0.5 * (zr - mr);
      scr.Yr[k] = yr; scr.Yi[k] = yi; scr.Rr[k] = rr; scr.Ri[k] = ri;
      cr[k] = yr * rr + yi * ri; ci[k] = yi * rr - yr * ri; pr[k] = rr * rr + ri * ri; py[k] = yr * yr + yi * yi;
    }
    boxSum(cr, bcr, K, F); boxSum(ci, bci, K, F); boxSum(pr, bpr, K, F); boxSum(py, bpy, K, F);
    for (let k = 0; k < K; k++) {
      const n = Math.min(k + F, K - 1) - Math.max(k - F, 0) + 1;
      st.Sxr[k] = lam * st.Sxr[k] + a * bcr[k] / n; st.Sxi[k] = lam * st.Sxi[k] + a * bci[k] / n;
      st.Srr[k] = lam * st.Srr[k] + a * bpr[k] / n; st.Syy[k] = lam * st.Syy[k] + a * bpy[k] / n;
      const srr = st.Srr[k], den = srr * (1 + o.reg) + 1e-12;
      const coh = (st.Sxr[k] * st.Sxr[k] + st.Sxi[k] * st.Sxi[k]) / (srr * st.Syy[k] + 1e-20);
      const sh = coh > o.coh0 ? 1 - o.coh0 / coh : 0;
      let tr = (st.Sxr[k] / den) * sh, ti = (st.Sxi[k] / den) * sh;
      const mag = Math.hypot(tr, ti);
      if (mag > o.maxGain) { tr *= o.maxGain / mag; ti *= o.maxGain / mag; }
      let wr = st.Wr[k] + o.mu * (tr - st.Wr[k]), wi = st.Wi[k] + o.mu * (ti - st.Wi[k]);
      const rr = scr.Rr[k], ri = scr.Ri[k];
      let er = scr.Yr[k] - (wr * rr - wi * ri), ei = scr.Yi[k] - (wr * ri + wi * rr);
      let pe = er * er + ei * ei;
      st.pe[k] = 0.9 * st.pe[k] + 0.1 * pe; st.py[k] = 0.9 * st.py[k] + 0.1 * py[k];
      if (st.pe[k] > 1.5 * st.py[k] + 1e-12) { // protezione dalla divergenza
        wr *= 0.5; wi *= 0.5;
        er = scr.Yr[k] - (wr * rr - wi * ri); ei = scr.Yi[k] - (wr * ri + wi * rr); pe = er * er + ei * ei;
        st.pe[k] = st.py[k];
      }
      st.Wr[k] = wr; st.Wi[k] = wi; Er[k] = er; Ei[k] = ei;
      cr[k] = er * rr + ei * ri; ci[k] = ei * rr - er * ri; pr[k] = pe; py[k] = rr * rr + ri * ri;
    }
    if (o.suppress) {
      boxSum(cr, bcr, K, F); boxSum(ci, bci, K, F); boxSum(pr, bpr, K, F);
      for (let k = 0; k < K; k++) {
        const n = Math.min(k + F, K - 1) - Math.max(k - F, 0) + 1;
        st.Ser[k] = lam * st.Ser[k] + a * bcr[k] / n; st.Sei[k] = lam * st.Sei[k] + a * bci[k] / n; st.See[k] = lam * st.See[k] + a * bpr[k] / n;
      }
      // potenze istantanee smussate in frequenza (3 bin) e in tempo
      for (let k = 0; k < K; k++) {
        const k0 = k > 0 ? k - 1 : 0, k1 = k < K - 1 ? k + 1 : K - 1;
        tmp[k] = 0.25 * pr[k0] + 0.5 * pr[k] + 0.25 * pr[k1];
        tmp2[k] = 0.25 * py[k0] + 0.5 * py[k] + 0.25 * py[k1];
      }
      for (let k = 0; k < K; k++) {
        // regressione in potenza: PE ~ kappa * PR (eco residuo non coerente in fase ma con la stessa inviluppo)
        st.Mpe[k] = lp * st.Mpe[k] + (1 - lp) * tmp[k]; st.Mpr[k] = lp * st.Mpr[k] + (1 - lp) * tmp2[k];
        st.Mpp[k] = lp * st.Mpp[k] + (1 - lp) * tmp2[k] * tmp2[k]; st.Mpx[k] = lp * st.Mpx[k] + (1 - lp) * tmp[k] * tmp2[k];
        const vr = st.Mpp[k] - st.Mpr[k] * st.Mpr[k], kap = vr > 1e-12 * st.Mpp[k] + 1e-20 ? Math.min(1, Math.max(0, (st.Mpx[k] - st.Mpe[k] * st.Mpr[k]) / vr)) : 0;
        st.pe2[k] = 0.5 * st.pe2[k] + 0.5 * tmp[k]; st.pr2[k] = 0.5 * st.pr2[k] + 0.5 * tmp2[k];
        const w2 = st.Wr[k] * st.Wr[k] + st.Wi[k] * st.Wi[k];
        const srr = st.Srr[k];
        const cyr = (st.Sxr[k] * st.Sxr[k] + st.Sxi[k] * st.Sxi[k]) / (srr * st.Syy[k] + 1e-20);
        const cer = (st.Ser[k] * st.Ser[k] + st.Sei[k] * st.Sei[k]) / (srr * st.See[k] + 1e-20);
        const pecho = w2 * st.pr2[k] * (o.c1 + o.c2 * (1 - Math.min(1, cyr))) + Math.min(1, cer) * st.pe2[k] + o.kappa * kap * st.pr2[k];
        let g = 1 - o.beta * bw[k] * pecho / (st.pe2[k] + 1e-12);
        tmp[k] = g < gMin ? gMin : g > 1 ? 1 : g;
      }
      for (let k = 0; k < K; k++) {
        const k0 = k > 0 ? k - 1 : 0, k1 = k < K - 1 ? k + 1 : K - 1;
        const gs = 0.25 * tmp[k0] + 0.5 * tmp[k] + 0.25 * tmp[k1];
        const al = gs < st.G[k] ? o.smoothDown : o.smoothUp;
        st.G[k] += al * (gs - st.G[k]);
      }
    }
    // Z = E + j O  (E: stadio lineare, O: dopo soppressione) -> un'unica IFFT
    for (let k = 0; k < K; k++) {
      const g = o.suppress ? st.G[k] : 1, er = Er[k], ei = Ei[k], or = g * er, oi = g * ei;
      re[k] = er - oi; im[k] = ei + or;
      if (k > 0 && k < N >> 1) { re[N - k] = er + oi; im[N - k] = -ei + or; }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) {
      const j = s + i - st.base;
      if (s + i >= 0) { st.o1[j] += 0.5 * w[i] * re[i]; st.o2[j] += 0.5 * w[i] * im[i]; }
    }
    st.fin = Math.max(st.fin, s + H);
    st.t++;
  }
}
function v3Scratch(P) {
  const { N, K } = P, f = () => new Float64Array(K);
  return { re: new Float64Array(N), im: new Float64Array(N), Yr: f(), Yi: f(), Rr: f(), Ri: f(), cr: f(), ci: f(), pr: f(), py: f(), bcr: f(), bci: f(), bpr: f(), bpy: f(), Er: f(), Ei: f(), tmp: f(), tmp2: f() };
}
export function createEchoRemoverV3({ delaySamples, sampleRate = 44100, channels = 1, opts = {} }) {
  const o = { ...V3_DEFAULTS, ...opts };
  const P = v3Params(delaySamples, sampleRate, o);
  const chs = Array.from({ length: channels }, () => v3Channel(P));
  const scr = v3Scratch(P);
  let total = 0, flushed = false;
  const emit = (limit) => chs.map((st) => {
    const n = Math.max(0, Math.min(st.fin, limit) - st.emitted), out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = st.o2[st.emitted + i - st.base]; out[i] = o.limiter ? softLimit(v) : v; }
    st.emitted += n;
    return out;
  });
  const compact = () => chs.forEach((st) => {
    const keep = Math.min(st.emitted, st.t * P.H - (P.N - P.H) - P.D) | 0;
    const nb = Math.max(st.base, keep);
    if (nb - st.base < 1 << 16) return;
    const d = nb - st.base;
    for (const k of ['inb', 'o1', 'o2']) { st[k].copyWithin(0, d); st[k].fill(0, st.cap - d); }
    st.base = nb;
  });
  return {
    latency: P.N - P.H, frame: P.N, hop: P.H, delaySamples: P.D,
    process(chunk) {
      if (flushed) throw new Error('flushed');
      const len = chunk[0].length;
      chs.forEach((st, c) => { v3Ensure(st, st.inEnd - st.base + len + P.N); st.inb.set(chunk[Math.min(c, chunk.length - 1)], st.inEnd - st.base); st.inEnd += len; });
      total += len;
      chs.forEach((st) => v3Frames(P, st, scr));
      const out = emit(Infinity); compact(); return out;
    },
    flush() {
      if (flushed) return chs.map(() => new Float32Array(0));
      flushed = true;
      chs.forEach((st) => { v3Ensure(st, st.inEnd - st.base + 2 * P.N); st.inEnd += 2 * P.N; v3Frames(P, st, scr); });
      return emit(total);
    },
  };
}
export function removeEchoV3(channels, sampleRate, { delaySamples, opts = {} }) {
  const rem = createEchoRemoverV3({ delaySamples, sampleRate, channels: channels.length, opts });
  const a = rem.process(channels), b = rem.flush();
  return a.map((x, c) => { const o = new Float32Array(x.length + b[c].length); o.set(x); o.set(b[c], x.length); return o; });
}
// metrica di danno: perdita di energia per banda (dB, out/ref) e correlazione per banda (segnali allineati)
export function echoBandDamage(ref, out, sampleRate, bands = ECHO_BANDS) {
  const n = Math.min(ref[0].length, out[0].length), a = mono(ref, 0, n), b = mono(out, 0, n);
  return bands.map((bd) => {
    const x = bandSignal(a, sampleRate, bd), y = bandSignal(b, sampleRate, bd);
    let xx = 0, yy = 0, xy = 0;
    for (let i = 0; i < n; i++) { xx += x[i] * x[i]; yy += y[i] * y[i]; xy += x[i] * y[i]; }
    return { lossDb: 10 * Math.log10((yy + 1e-20) / (xx + 1e-20)), corr: xy / Math.sqrt(xx * yy + 1e-20) };
  });
}
