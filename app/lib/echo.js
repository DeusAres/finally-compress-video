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
