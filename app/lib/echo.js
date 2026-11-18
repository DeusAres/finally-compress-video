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
// Modello per bin (canali accoppiati a coppie L/R, con riferimento anche cross-canale perche' la sorgente
// s2 e' un render spaziale/mix: l'eco di R nasce anche da L):
//    Y_c(k,t) = X_c(k,t) + sum_j W_cj(k,t) R_j(k,t),   R_j = STFT di xhat1_j[n-D]  (D = round(d)),
// con xhat1 = uscita dello stadio lineare (OLA) gia' pulita => struttura ricorsiva come v2 (IIR).
// Il ritardo frazionario (d-D) e' assorbito dalla fase complessa di W. W: LS ricorsivo con memoria esponenziale
// (RLS a 1-2 tap per bin; statistiche mediate in tempo (lambda) e su +-span bin), shrink alla Wiener della coerenza
// multipla (toglie il bias a coerenza ~0), rilassamento W <- W + mu (W_ls - W), ||W_c|| <= maxGain (<0.95),
// protezione dalla divergenza (potenza di E > 1.5x quella di Y nel bin -> W dimezzata).
// Post-filtro: G = max(Gmin, 1 - beta(f) Pecho/PE), Pecho = sum_j|W_cj|^2|R_j|^2 (c1 + c2 (1-gamma_yr^2)) + gamma_er^2 PE;
//    G smussato in frequenza (3 tap) e in tempo (attacco rapido, rilascio lento); beta(f) ~1 in 1.8-8 kHz.
// Vincolo: finestra N <= D (il riferimento ritardato e' sempre gia' finalizzato); N = 1024 (D~1841), hop N/4.
// Latenza: STFT con finestra N, hop H = N/4 => latenza N-H campioni (768 @ N=1024, 17.4 ms).
//   Il flusso e' ALLINEATO: l'uscita campione i corrisponde all'ingresso campione i. process() emette i campioni
//   man mano che sono definitivi (cumulativamente `latency` in meno dell'ingresso); flush() emette il resto,
//   quindi sum(uscite) == sum(ingressi). removeEchoV3 (batch) = process + flush; streaming == batch (bit-exact).
// ======================================================================================
const V3_DEFAULTS = {
  frame: 1024, lambda: 0.97, mu: 0.3, span: 2, maxGain: 0.94, coh0: 0.03, reg: 0.02, cross: true, crossHz: 1500, maxHz: 8000,
  suppress: true, gMinDb: -12, beta: 0.3, c1: 0.15, c2: 0.5, bandsHz: [1000, 1800, 6000, 8000], tailBeta: 0.25,
  smoothUp: 0.35, smoothDown: 0.7, limiter: true,
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
  const xbin = new Uint8Array(K), cnt = new Float64Array(K);
  const KP = Math.min(K, Math.floor((o.maxHz * N) / sampleRate) + 1);
  for (let k = 0; k < K; k++) { xbin[k] = (k * sampleRate) / N >= o.crossHz ? 1 : 0; cnt[k] = Math.min(k + o.span, KP - 1) - Math.max(k - o.span, 0) + 1; }
  return { D, N, H, K, KP, w, bw, xbin, cnt, gMin: Math.pow(10, o.gMinDb / 20), o };
}
const F64 = (n) => new Float64Array(n);
// gruppo di 1 o 2 canali accoppiati (il secondo canale di un gruppo mono e' fittizio)
function v3Group(P, nch) {
  const { K, N } = P, f = () => F64(K), cx = () => ({ r: f(), i: f() });
  const ch = () => ({
    base: 0, cap: 0, inb: F64(0), o1: F64(0), o2: F64(0), emitted: 0,
    Wr: [f(), f()], Wi: [f(), f()], Br: [f(), f()], Bi: [f(), f()], Syy: f(), pe: f(), py: f(),
    Ser: [f(), f()], Sei: [f(), f()], See: f(), pe2: f(), G: F64(K).fill(1),
    Yr: f(), Yi: f(), Rr: f(), Ri: f(), Er: f(), Ei: f(), yy: f(),
  });
  return {
    nch, cross: nch === 2 && P.o.cross, c: [ch(), ch()], inEnd: 0, t: 0, fin: 0,
    pr2: [f(), f()], A00: f(), A11: f(), A01r: f(), A01i: f(),
    s: { re: F64(N), im: F64(N), tmp: F64(K), tmp2: F64(K), tmp3: F64(K), x: Array.from({ length: 16 }, f), bx: Array.from({ length: 16 }, f) },
  };
}
function v3Ensure(st, need) {
  if (st.cap >= need) return;
  const cap = Math.max(need, st.cap * 2, 1 << 16);
  for (const k of ['inb', 'o1', 'o2']) { const a = F64(cap); a.set(st[k]); st[k] = a; }
  st.cap = cap;
}
function v3Frames(P, g) {
  const { N, H, K, D, w, bw, gMin, o } = P, M = N - 1, half = N >> 1;
  const lam = o.lambda, a = 1 - lam, F = o.span, reg = 1 + o.reg;
  const { re, im, tmp, tmp2, x, bx } = g.s, nc = g.nch, cross = g.cross, c0 = g.c[0], c1 = g.c[1];
  const mg2 = o.maxGain * o.maxGain, mu = o.mu, xb = P.xbin;
  const cnt = P.cnt, KP = P.KP;
  while (true) {
    const s = g.t * H - (N - H);
    if (s + N > g.inEnd) break;
    for (let q = 0; q < nc; q++) {
      const st = g.c[q];
      v3Ensure(st, s + N - st.base + 1);
      const inb = st.inb, o1 = st.o1, base = st.base;
      for (let i = 0; i < N; i++) {
        const ai = s + i, ar = ai - D;
        re[i] = (ai >= 0 ? inb[ai - base] : 0) * w[i];
        im[i] = (ar >= 0 ? o1[ar - base] : 0) * w[i];
      }
      fft(re, im);
      const Yr = st.Yr, Yi = st.Yi, Rr = st.Rr, Ri = st.Ri, yy = st.yy;
      for (let k = 0; k < K; k++) { // separa Y (parte reale) e R (parte immaginaria)
        const m = (N - k) & M, zr = re[k], zi = im[k], mr = re[m], mi = im[m];
        const yr = 0.5 * (zr + mr), yi = 0.5 * (zi - mi);
        Yr[k] = yr; Yi[k] = yi; Rr[k] = 0.5 * (zi + mi); Ri[k] = -0.5 * (zr - mr); yy[k] = yr * yr + yi * yi;
      }
    }
    // statistiche istantanee: 0 A00, 1 A11, 2-3 A01, 4.. b_qj (r,i) a 4+q*4+j*2, 12+q yy_q
    const R0r = c0.Rr, R0i = c0.Ri, R1r = c1.Rr, R1i = c1.Ri;
    for (let k = 0; k < KP; k++) {
      const r0r = R0r[k], r0i = R0i[k];
      x[0][k] = r0r * r0r + r0i * r0i;
      if (cross) {
        const r1r = R1r[k], r1i = R1i[k];
        x[1][k] = r1r * r1r + r1i * r1i; x[2][k] = r0r * r1r + r0i * r1i; x[3][k] = r0i * r1r - r0r * r1i;
      }
      for (let q = 0; q < nc; q++) {
        const st = g.c[q], yr = st.Yr[k], yi = st.Yi[k], p = 4 + q * 4;
        x[p][k] = yr * r0r + yi * r0i; x[p + 1][k] = yi * r0r - yr * r0i;
        if (cross) { const r1r = R1r[k], r1i = R1i[k]; x[p + 2][k] = yr * r1r + yi * r1i; x[p + 3][k] = yi * r1r - yr * r1i; }
      }
    }
    boxSum(x[0], bx[0], KP, F);
    if (cross) { boxSum(x[1], bx[1], KP, F); boxSum(x[2], bx[2], KP, F); boxSum(x[3], bx[3], KP, F); }
    for (let q = 0; q < nc; q++) {
      const p = 4 + q * 4;
      boxSum(x[p], bx[p], KP, F); boxSum(x[p + 1], bx[p + 1], KP, F);
      if (cross) { boxSum(x[p + 2], bx[p + 2], KP, F); boxSum(x[p + 3], bx[p + 3], KP, F); }
    }
    const A00 = g.A00, A11 = g.A11, A01r = g.A01r, A01i = g.A01i;
    for (let k = 0; k < KP; k++) {
      const an = a / cnt[k], cx = cross && xb[k];
      A00[k] = lam * A00[k] + an * bx[0][k];
      if (cross) { A11[k] = lam * A11[k] + an * bx[1][k]; A01r[k] = lam * A01r[k] + an * bx[2][k]; A01i[k] = lam * A01i[k] + an * bx[3][k]; }
      const a00 = A00[k] * reg + 1e-12, a11 = A11[k] * reg + 1e-12, a01r = A01r[k], a01i = A01i[k];
      const det = cx ? a00 * a11 - a01r * a01r - a01i * a01i : 1;
      const coh0 = o.coh0 * (cx ? 2 : 1);
      for (let q = 0; q < nc; q++) {
        const st = g.c[q], p = 4 + q * 4;
        st.Syy[k] = lam * st.Syy[k] + a * st.yy[k];
        const Br0 = st.Br[0], Bi0 = st.Bi[0], Br1 = st.Br[1], Bi1 = st.Bi[1];
        Br0[k] = lam * Br0[k] + an * bx[p][k]; Bi0[k] = lam * Bi0[k] + an * bx[p + 1][k];
        if (cross) { Br1[k] = lam * Br1[k] + an * bx[p + 2][k]; Bi1[k] = lam * Bi1[k] + an * bx[p + 3][k]; }
        const b0r = Br0[k], b0i = Bi0[k], b1r = Br1[k], b1i = Bi1[k], syy = st.Syy[k] + 1e-20;
        let w0r = 0, w0i = 0, w1r = 0, w1i = 0, coh;
        if (cx) {
          // W0 = (b0 A11 - b1 conj(A01))/det ; W1 = (A00 b1 - A01 b0)/det
          w0r = (b0r * a11 - (b1r * a01r + b1i * a01i)) / det; w0i = (b0i * a11 - (b1i * a01r - b1r * a01i)) / det;
          w1r = (a00 * b1r - (a01r * b0r - a01i * b0i)) / det; w1i = (a00 * b1i - (a01r * b0i + a01i * b0r)) / det;
          coh = (w0r * b0r + w0i * b0i + w1r * b1r + w1i * b1i) / syy;
        } else if (q === 0) { // riferimento proprio = canale 0
          w0r = b0r / a00; w0i = b0i / a00; coh = (b0r * b0r + b0i * b0i) / (A00[k] * syy);
        } else { // q = 1, riferimento proprio = canale 1 (b_q1)
          w1r = b1r / a11; w1i = b1i / a11; coh = (b1r * b1r + b1i * b1i) / (A11[k] * syy);
        }
        const sh = coh > coh0 ? 1 - coh0 / Math.min(coh, 1) : 0;
        w0r *= sh; w0i *= sh; w1r *= sh; w1i *= sh;
        const nrm = w0r * w0r + w0i * w0i + w1r * w1r + w1i * w1i;
        if (nrm > mg2) { const sc = o.maxGain / Math.sqrt(nrm); w0r *= sc; w0i *= sc; w1r *= sc; w1i *= sc; }
        const Wr0 = st.Wr[0], Wi0 = st.Wi[0], Wr1 = st.Wr[1], Wi1 = st.Wi[1];
        let u0r = Wr0[k] + mu * (w0r - Wr0[k]), u0i = Wi0[k] + mu * (w0i - Wi0[k]);
        let u1r = Wr1[k] + mu * (w1r - Wr1[k]), u1i = Wi1[k] + mu * (w1i - Wi1[k]);
        const yr = st.Yr[k], yi = st.Yi[k], r0r = R0r[k], r0i = R0i[k], r1r = R1r[k], r1i = R1i[k];
        let er = yr - (u0r * r0r - u0i * r0i) - (u1r * r1r - u1i * r1i), ei = yi - (u0r * r0i + u0i * r0r) - (u1r * r1i + u1i * r1r);
        st.pe[k] = 0.9 * st.pe[k] + 0.1 * (er * er + ei * ei); st.py[k] = 0.9 * st.py[k] + 0.1 * st.yy[k];
        if (st.pe[k] > 1.5 * st.py[k] + 1e-12) { // protezione dalla divergenza
          u0r *= 0.5; u0i *= 0.5; u1r *= 0.5; u1i *= 0.5;
          er = yr - (u0r * r0r - u0i * r0i) - (u1r * r1r - u1i * r1i); ei = yi - (u0r * r0i + u0i * r0r) - (u1r * r1i + u1i * r1r);
          st.pe[k] = st.py[k];
        }
        Wr0[k] = u0r; Wi0[k] = u0i; Wr1[k] = u1r; Wi1[k] = u1i; st.Er[k] = er; st.Ei[k] = ei;
      }
    }
    if (o.suppress) {
      const nj = cross ? 2 : 1;
      for (let j = 0; j < nj; j++) { // potenza di R_j smussata (3 tap) e nel tempo, condivisa dai canali del gruppo
        const Rr = j ? R1r : R0r, Ri = j ? R1i : R0i, pr2 = g.pr2[j];
        for (let k = 0; k < KP; k++) x[2][k] = Rr[k] * Rr[k] + Ri[k] * Ri[k];
        for (let k = 0; k < KP; k++) {
          const k0 = k > 0 ? k - 1 : 0, k1 = k < KP - 1 ? k + 1 : KP - 1;
          pr2[k] = 0.5 * pr2[k] + 0.5 * (0.25 * x[2][k0] + 0.5 * x[2][k] + 0.25 * x[2][k1]);
        }
      }
      for (let q = 0; q < nc; q++) {
        const st = g.c[q], Er = st.Er, Ei = st.Ei;
        for (let j = 0; j < nj; j++) { // coerenza E-R_j (solo media temporale)
          const Rr = j ? R1r : R0r, Ri = j ? R1i : R0i, Ser = st.Ser[j], Sei = st.Sei[j];
          for (let k = 0; k < KP; k++) { Ser[k] = lam * Ser[k] + a * (Er[k] * Rr[k] + Ei[k] * Ri[k]); Sei[k] = lam * Sei[k] + a * (Ei[k] * Rr[k] - Er[k] * Ri[k]); }
        }
        const See = st.See, pe2 = st.pe2;
        for (let k = 0; k < KP; k++) x[2][k] = Er[k] * Er[k] + Ei[k] * Ei[k];
        for (let k = 0; k < KP; k++) {
          const k0 = k > 0 ? k - 1 : 0, k1 = k < KP - 1 ? k + 1 : KP - 1;
          See[k] = lam * See[k] + a * x[2][k];
          pe2[k] = 0.5 * pe2[k] + 0.5 * (0.25 * x[2][k0] + 0.5 * x[2][k] + 0.25 * x[2][k1]);
        }
        for (let k = 0; k < KP; k++) {
          const e2 = pe2[k], syy = st.Syy[k] * 1 + 1e-20;
          let pw = g.pr2[0][k] * (st.Wr[0][k] * st.Wr[0][k] + st.Wi[0][k] * st.Wi[0][k]);
          let cer = (st.Ser[0][k] * st.Ser[0][k] + st.Sei[0][k] * st.Sei[0][k]) / (A00[k] * See[k] + 1e-20);
          let cyr = (st.Br[0][k] * st.Br[0][k] + st.Bi[0][k] * st.Bi[0][k]) / (A00[k] * syy);
          if (cross) {
            pw += g.pr2[1][k] * (st.Wr[1][k] * st.Wr[1][k] + st.Wi[1][k] * st.Wi[1][k]);
            const c2 = (st.Ser[1][k] * st.Ser[1][k] + st.Sei[1][k] * st.Sei[1][k]) / (A11[k] * See[k] + 1e-20);
            if (c2 > cer) cer = c2;
            const y2 = (st.Br[1][k] * st.Br[1][k] + st.Bi[1][k] * st.Bi[1][k]) / (A11[k] * syy);
            if (y2 > cyr) cyr = y2;
          }
          const pecho = pw * (o.c1 + o.c2 * (1 - (cyr > 1 ? 1 : cyr))) + (cer > 1 ? 1 : cer) * e2;
          const gg = 1 - o.beta * bw[k] * pecho / (e2 + 1e-12);
          tmp2[k] = gg < gMin ? gMin : gg > 1 ? 1 : gg;
        }
        const G = st.G;
        for (let k = 0; k < KP; k++) {
          const k0 = k > 0 ? k - 1 : 0, k1 = k < KP - 1 ? k + 1 : KP - 1;
          const gs = 0.25 * tmp2[k0] + 0.5 * tmp2[k] + 0.25 * tmp2[k1];
          G[k] += (gs < G[k] ? o.smoothDown : o.smoothUp) * (gs - G[k]);
        }
      }
    }
    if (KP < K) for (let q = 0; q < nc; q++) { const st = g.c[q]; for (let k = KP; k < K; k++) { st.Er[k] = st.Yr[k]; st.Ei[k] = st.Yi[k]; } }
    for (let q = 0; q < nc; q++) { // Z = E + j O (E: stadio lineare, O: dopo soppressione) -> un'unica IFFT
      const st = g.c[q], G = st.G, Er = st.Er, Ei = st.Ei, sup = o.suppress;
      for (let k = 0; k < K; k++) {
        const gk = sup ? G[k] : 1, er = Er[k], ei = Ei[k], or = gk * er, oi = gk * ei;
        re[k] = er - oi; im[k] = ei + or;
        if (k > 0 && k < half) { re[N - k] = er + oi; im[N - k] = -ei + or; }
      }
      fft(re, im, true);
      const o1 = st.o1, o2 = st.o2, base = st.base;
      for (let i = 0; i < N; i++) {
        if (s + i >= 0) { const j = s + i - base, ww = 0.5 * w[i]; o1[j] += ww * re[i]; o2[j] += ww * im[i]; }
      }
    }
    g.fin = Math.max(g.fin, s + H);
    g.t++;
  }
}
export function createEchoRemoverV3({ delaySamples, sampleRate = 44100, channels = 1, opts = {} }) {
  const o = { ...V3_DEFAULTS, ...opts };
  const P = v3Params(delaySamples, sampleRate, o);
  const groups = [];
  const step = o.cross ? 2 : 1;
  for (let c = 0; c < channels; c += step) groups.push({ c0: c, g: v3Group(P, c + step <= channels ? step : 1) });
  let total = 0, flushed = false;
  const emit = (limit) => {
    const out = [];
    for (const { g } of groups) for (let q = 0; q < g.nch; q++) {
      const st = g.c[q], n = Math.max(0, Math.min(g.fin, limit) - st.emitted), buf = new Float32Array(n);
      for (let i = 0; i < n; i++) { const v = st.o2[st.emitted + i - st.base]; buf[i] = o.limiter ? softLimit(v) : v; }
      st.emitted += n; out.push(buf);
    }
    return out;
  };
  const compact = () => groups.forEach(({ g }) => {
    const keep = Math.min(g.c[0].emitted, g.t * P.H - (P.N - P.H) - P.D) | 0;
    for (let q = 0; q < g.nch; q++) {
      const st = g.c[q], nb = Math.max(st.base, keep);
      if (nb - st.base < 1 << 16) continue;
      const d = nb - st.base;
      for (const k of ['inb', 'o1', 'o2']) { st[k].copyWithin(0, d); st[k].fill(0, st.cap - d); }
      st.base = nb;
    }
  });
  return {
    latency: P.N - P.H, frame: P.N, hop: P.H, delaySamples: P.D,
    process(chunk) {
      if (flushed) throw new Error('flushed');
      const len = chunk[0].length;
      for (const { c0, g } of groups) {
        for (let q = 0; q < g.nch; q++) { const st = g.c[q]; v3Ensure(st, g.inEnd - st.base + len + P.N); st.inb.set(chunk[Math.min(c0 + q, chunk.length - 1)], g.inEnd - st.base); }
        g.inEnd += len; v3Frames(P, g);
      }
      total += len;
      const out = emit(Infinity); compact(); return out;
    },
    flush() {
      if (flushed) return Array.from({ length: channels }, () => new Float32Array(0));
      flushed = true;
      for (const { g } of groups) { for (let q = 0; q < g.nch; q++) v3Ensure(g.c[q], g.inEnd - g.c[q].base + 2 * P.N); g.inEnd += 2 * P.N; v3Frames(P, g); }
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
