import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { detectEcho, estimateGain, removeEcho, createEchoRemover } from './echo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SR = 44100;
function decode(file, map, sr = SR) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(root, file), '-map', map, '-f', 'f32le', '-ac', '2', '-ar', String(sr), '-'],
    { maxBuffer: 1 << 30 });
  assert.equal(r.status, 0, r.stderr?.toString());
  const f = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
  const n = f.length >> 1, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  return [L, R];
}
const fmt = (v) => v.toFixed(3);

// 1. rilevamento
const y = decode('IMG_7440.mov', '0:a:0');
const det = detectEcho(y, SR);
console.log(`7440: found=${det.found} d=${det.delayMs.toFixed(3)} ms (${det.delaySamples.toFixed(2)} smp) rho=${fmt(det.rho)} cons=${fmt(det.consistency)} win=${det.perWindow.length}`);
assert.ok(det.found);
assert.ok(Math.abs(det.delayMs - 41.75) < 0.3, 'delay ~41.75 ms');

// 2. rimozione
const g = estimateGain(y, SR, det.delaySamples, { rho: det.rho });
console.log(`gain a_lo=${g.gain.toFixed(3)} a_hi=${g.gainHigh.toFixed(3)} (xover ${g.crossoverHz} Hz; analitico ${g.analytic.gain.toFixed(3)}/${g.analytic.gainHigh.toFixed(3)}) r(d) mono raw before=${fmt(g.rhoBefore)} after=${fmt(g.rhoAfter)}`);
const t0 = performance.now();
const x = removeEcho(y, SR, { delaySamples: det.delaySamples, gain: g.gain, gainHigh: g.gainHigh, crossoverHz: g.crossoverHz });
const dt = performance.now() - t0;
const per10 = (dt / (y[0].length / SR)) * 10;
console.log(`perf: removeEcho ${per10.toFixed(1)} ms / 10 s audio (stereo)`);
const t1 = performance.now(); detectEcho(y, SR); const td = performance.now() - t1;
console.log(`perf: detectEcho ${td.toFixed(0)} ms per ${(y[0].length / SR).toFixed(1)} s audio`);

// rho prima/dopo per finestra al lag d e 2d (stessa pre-enfasi del detector, valore al lag frazionario)
function rhoAt(ch, lag) {
  const out = [];
  for (let s = 0; s + SR <= ch[0].length; s += SR) {
    const w = new Float64Array(SR);
    for (let i = 1; i < SR; i++) { const m = ch[0][s + i] + ch[1][s + i], mp = ch[0][s + i - 1] + ch[1][s + i - 1]; w[i] = m - 0.9 * mp; }
    const D = Math.floor(lag), f = lag - D;
    let n = 0, e0 = 0, e1 = 0;
    for (let i = D + 1; i < SR; i++) { const v = (1 - f) * w[i - D] + f * w[i - D - 1]; n += w[i] * v; e0 += w[i] * w[i]; e1 += v * v; }
    out.push(n / Math.sqrt(e0 * e1));
  }
  return out;
}
const d = det.delaySamples;
const b1 = rhoAt(y, d), a1 = rhoAt(x, d), b2 = rhoAt(y, 2 * d), a2 = rhoAt(x, 2 * d);
console.log('rho(d)  prima:', b1.map(fmt).join(' '));
console.log('rho(d)  dopo :', a1.map(fmt).join(' '));
console.log('rho(2d) prima:', b2.map(fmt).join(' '));
console.log('rho(2d) dopo :', a2.map(fmt).join(' '));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
assert.ok(mean(a1.map(Math.abs)) < 0.35 * mean(b1), 'rho(d) scende nettamente');
assert.ok(Math.max(...a2.map(Math.abs)) < 0.1, 'nessun picco a 2d');
const detAfter = detectEcho(x, SR);
console.log(`dopo: detectEcho found=${detAfter.found} rho=${fmt(detAfter.rho)} cons=${fmt(detAfter.consistency)}`);
let peak = 0; for (const c of x) for (const v of c) peak = Math.max(peak, Math.abs(v));
console.log(`peak dopo = ${peak.toFixed(3)}`);
assert.ok(peak <= 1);

// streaming == batch
{
  const rem = createEchoRemover({ delaySamples: d, gain: g.gain, gainHigh: g.gainHigh, crossoverHz: g.crossoverHz, sampleRate: SR, channels: 2 });
  const parts = []; let p = 0;
  for (const n of [1000, 7, 4096, 33333, 1e9]) {
    const e = Math.min(y[0].length, p + n); if (e <= p) break;
    parts.push(rem.process(y.map((c) => c.subarray(p, e)))); p = e;
  }
  let maxd = 0, off = 0;
  for (const pc of parts) { for (let c = 0; c < 2; c++) for (let i = 0; i < pc[c].length; i++) maxd = Math.max(maxd, Math.abs(pc[c][i] - x[c][off + i])); off += pc[0].length; }
  console.log(`streaming vs batch max diff = ${maxd}`);
  assert.ok(maxd < 1e-6);
}

// 3. controlli negativi
function pink(n, seed) {
  let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
  const out = new Float32Array(n); const b = new Float64Array(7);
  for (let i = 0; i < n; i++) {
    const w = rnd();
    b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852;
    b[3] = 0.8665 * b[3] + w * 0.3104856; b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898;
    out[i] = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.1; b[6] = w * 0.115926;
    out[i] += 0.1 * Math.sin(2 * Math.PI * (300 + 200 * Math.sin(i / SR)) * i / SR);
  }
  return out;
}
const syn = [pink(SR * 10, 1), pink(SR * 10, 2)];
const ds = detectEcho(syn, SR);
console.log(`negativo sintetico: found=${ds.found} rho=${fmt(ds.rho)} cons=${fmt(ds.consistency)}`);
assert.ok(!ds.found);
const synEcho = syn.map((c) => { const o = new Float32Array(c); for (let i = 1841; i < o.length; i++) o[i] += 0.45 * c[i - 1841]; return o; });
const dse = detectEcho(synEcho, SR);
console.log(`positivo sintetico (a=0.45,d=1841): found=${dse.found} d=${dse.delaySamples.toFixed(2)} rho=${fmt(dse.rho)}`);
assert.ok(dse.found && Math.abs(dse.delaySamples - 1841) < 0.5);
const gse = estimateGain(synEcho, SR, dse.delaySamples, { rho: dse.rho });
console.log(`  gain stimato=${gse.gain.toFixed(3)}/${gse.gainHigh.toFixed(3)} (vero 0.45)`);

const y2 = decode('IMG_2147.mov', '0:a:1');
const d2 = detectEcho(y2, SR);
console.log(`2147 (${(y2[0].length / SR).toFixed(1)} s): found=${d2.found} d=${d2.delayMs.toFixed(2)} ms rho=${fmt(d2.rho)} cons=${fmt(d2.consistency)} win=${d2.perWindow.length}`);
console.log('   per finestra:', d2.perWindow.map((p) => `${p.lagMs.toFixed(2)}ms/${fmt(p.rho)}`).join(' '));
assert.ok(!d2.found);

// 4. uscita per ascolto
const buf = new Float32Array(x[0].length * 2);
for (let i = 0; i < x[0].length; i++) { buf[2 * i] = x[0][i]; buf[2 * i + 1] = x[1][i]; }
const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', '-', '-c:a', 'aac', '-b:a', '192k', '/tmp/claude-0/lab/7440_fixed.m4a'],
  { input: Buffer.from(buf.buffer) });
assert.equal(enc.status, 0, enc.stderr?.toString());
console.log('scritto /tmp/claude-0/lab/7440_fixed.m4a');
console.log('OK');
