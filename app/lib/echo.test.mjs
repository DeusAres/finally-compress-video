import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { detectEcho, estimateGain, removeEcho, createEchoRemover, estimateEchoFilter, removeEchoV2, createEchoRemoverV2, echoBandRho, echoCepstrumComb, echoFilterMaxResponse, removeEchoV3, createEchoRemoverV3, echoBandDamage, removeEchoV4, estimateEchoV4, applyEchoV4 } from './echo.js';

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
const y = decode('samples/IMG_7440.mov', '0:a:0');
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

const y2 = decode('samples/IMG_2147.mov', '0:a:1');
const d2 = detectEcho(y2, SR);
console.log(`2147 (${(y2[0].length / SR).toFixed(1)} s): found=${d2.found} d=${d2.delayMs.toFixed(2)} ms rho=${fmt(d2.rho)} cons=${fmt(d2.consistency)} win=${d2.perWindow.length}`);
console.log('   per finestra:', d2.perWindow.map((p) => `${p.lagMs.toFixed(2)}ms/${fmt(p.rho)}`).join(' '));
assert.ok(!d2.found);

// 3b. v2: filtro FIR per eco con percorso filtrato (non identico alla sorgente)
{
  const bandNames = ['<500', '0.5-2k', '2-6k', '>6k'];
  const enc = (chs, name) => {
    const n = chs[0].length, b = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { b[2 * i] = chs[0][i]; b[2 * i + 1] = chs[1][i]; }
    const e = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', '-', '-c:a', 'aac', '-b:a', '256k', `/tmp/claude-0/lab/${name}.m4a`], { input: Buffer.from(b.buffer) });
    assert.equal(e.status, 0, e.stderr?.toString());
  };
  const t2 = performance.now();
  const est = estimateEchoFilter(y, SR, d);
  console.log(`v2 estimateEchoFilter: ${(performance.now() - t2).toFixed(0)} ms, taps=${est.taps} maxResponse=${est.maxResponse.toFixed(3)} scale=${est.scale.toFixed(3)}`);
  assert.ok(echoFilterMaxResponse(est.h[0]) < 1 && echoFilterMaxResponse(est.h[1]) < 1, 'filtro stabile');
  const timeIt = (fn) => { const t = performance.now(); const o = fn(); return [o, ((performance.now() - t) / (y[0].length / SR)) * 10]; };
  const [xi, ti] = timeIt(() => removeEchoV2(y, SR, { delaySamples: d, h: est.h, mode: 'iir' }));
  const [xf, tf] = timeIt(() => removeEchoV2(y, SR, { delaySamples: d, h: est.h, mode: 'fir', stages: 3 }));
  console.log(`perf v2: iir ${ti.toFixed(0)} ms / 10 s stereo, fir(3 stadi) ${tf.toFixed(0)} ms / 10 s stereo`);
  const rows = { v0: y, v1: x, 'v2-iir': xi, 'v2-fir': xf };
  const res = {};
  console.log('rho al lag d/2d/3d per banda (media su finestre da 1 s) + comb cepstrum picco/pavimento');
  console.log('modo     ' + bandNames.map((b) => b.padEnd(15)).join('') + 'comb');
  for (const [k, v] of Object.entries(rows)) {
    res[k] = echoBandRho(v, SR, d);
    const cc = echoCepstrumComb(v, SR, d); res[k].comb = cc.ratio;
    console.log(k.padEnd(9) + res[k].map((r) => r.map((q) => q.toFixed(2)).join('/').padEnd(15)).join('') + cc.ratio.toFixed(1));
  }
  for (const k of ['v2-iir', 'v2-fir']) {
    for (let b = 0; b < 4; b++) {
      assert.ok(res[k][b][0] < res.v0[b][0], `${k}: rho(d) scende nella banda ${bandNames[b]}`);
      assert.ok(res[k][b][1] < 0.15 && res[k][b][2] < 0.15, `${k}: niente picchi a 2d/3d banda ${bandNames[b]}`);
    }
    assert.ok(res[k][0][0] < 0.3 * res.v0[0][0] && res[k][1][0] < 0.4 * res.v0[1][0], `${k}: basse fortemente ridotte`);
    assert.ok(res[k].comb < res.v0.comb && res[k].comb < res.v1.comb, `${k}: comb < v0 e v1`);
  }
  assert.ok(res['v2-iir'][3][0] < res.v1[3][0], 'v2 non peggiora le alte come v1');
  let pk2 = 0; for (const c of xi) for (const v of c) pk2 = Math.max(pk2, Math.abs(v));
  assert.ok(pk2 <= 1);
  assert.ok(ti < 1000, 'iir >> realtime');
  enc(x, '7440_v1'); enc(xi, '7440_v2iir'); enc(xf, '7440_v2fir');
  console.log('scritti /tmp/claude-0/lab/7440_{v1,v2iir,v2fir}.m4a');

  // streaming == batch, entrambi i modi, blocchi dispari
  for (const mode of ['iir', 'fir']) {
    const batch = mode === 'iir' ? xi : xf;
    const rem = createEchoRemoverV2({ delaySamples: d, h: est.h, mode, stages: 3, channels: 2 });
    let p = 0, maxd = 0;
    for (const n of [1000, 7, 4096, 33333, 1e9]) {
      const e = Math.min(y[0].length, p + n); if (e <= p) break;
      const o = rem.process(y.map((c) => c.subarray(p, e)));
      for (let c = 0; c < 2; c++) for (let i = 0; i < o[c].length; i++) maxd = Math.max(maxd, Math.abs(o[c][i] - batch[c][p + i]));
      p = e;
    }
    console.log(`v2 streaming vs batch (${mode}) max diff = ${maxd}`);
    assert.ok(maxd < 1e-6);
  }

  // sintetico: eco NON identico (percorso passa-basso disperso + tap anticipato), v2 deve ridurre in ogni banda
  const D0 = 1841, g = [0.35, 0.2, 0.1, 0.05, 0.03];
  const sx = [pink(SR * 12, 11), pink(SR * 12, 12)];
  const sy = sx.map((c) => { const o = new Float32Array(c); for (let i = D0 + 5; i < o.length; i++) { let a = 0.15 * c[i - D0 + 2]; for (let k = 0; k < g.length; k++) a += g[k] * c[i - D0 - k]; o[i] += a; } return o; });
  const sdet = detectEcho(sy, SR);
  assert.ok(sdet.found && Math.abs(sdet.delaySamples - D0) < 3, 'rileva eco sintetico filtrato');
  const sest = estimateEchoFilter(sy, SR, sdet.delaySamples);
  const sb = echoBandRho(sy, SR, sdet.delaySamples);
  for (const mode of ['iir', 'fir']) {
    const sr2 = echoBandRho(removeEchoV2(sy, SR, { delaySamples: sdet.delaySamples, h: sest.h, mode }), SR, sdet.delaySamples);
    console.log(`sintetico ${mode}: prima ${sb.map((r) => r[0].toFixed(2)).join('/')} dopo ${sr2.map((r) => r[0].toFixed(2)).join('/')} (2d: ${sr2.map((r) => r[1].toFixed(2)).join('/')})`);
    for (let b = 0; b < 4; b++) {
      if (sb[b][0] > 0.2) assert.ok(sr2[b][0] < 0.5 * sb[b][0], `sintetico ${mode}: banda ${bandNames[b]} ridotta`);
      assert.ok(sr2[b][1] < 0.12 && sr2[b][2] < 0.12, `sintetico ${mode}: no picchi 2d/3d`);
    }
  }
  // stabilita': h con risposta > 1 viene scalata
  const hot = estimateEchoFilter(sx.map((c) => { const o = new Float32Array(c); for (let i = D0; i < o.length; i++) o[i] += 1.5 * c[i - D0]; return o; }), SR, D0);
  console.log(`eco forte (1.5): maxResponse=${hot.maxResponse.toFixed(3)} scale=${hot.scale.toFixed(3)}`);
  assert.ok(echoFilterMaxResponse(hot.h[0]) <= 0.9 + 1e-9, 'h sempre scalata a max_f|H|<=0.9');
  // controllo negativo: senza eco h ~ 0, e detect resta false
  const nest = estimateEchoFilter(syn, SR, 1841);
  console.log(`negativo v2: maxResponse=${nest.maxResponse.toFixed(3)}`);
  assert.ok(nest.maxResponse < 0.25 && !detectEcho(syn, SR).found);
}


// 3c. v3: cancellazione adattiva STFT (cross-canale) + soppressione residua
{
  const bandNames = ['<500', '0.5-2k', '2-6k', '>6k'];
  const est = estimateEchoFilter(y, SR, d);
  const xv2 = removeEchoV2(y, SR, { delaySamples: d, h: est.h, mode: 'iir' });
  const run = () => { const t = performance.now(); const o = removeEchoV3(y, SR, { delaySamples: d }); return [o, ((performance.now() - t) / (y[0].length / SR)) * 10]; };
  let [xv3, t3] = run(); { const [, t3b] = run(); t3 = Math.min(t3, t3b); }
  console.log(`perf v3: ${t3.toFixed(0)} ms / 10 s stereo (${(10000 / t3).toFixed(1)}x realtime)`);
  assert.equal(xv3[0].length, y[0].length, 'v3: stessa lunghezza (allineato)');
  const res = {};
  console.log('v3 vs v2: rho al lag d/2d/3d per banda + comb cepstrum; danno = perdita energia dB / correlazione col segnale originale');
  console.log('modo     ' + bandNames.map((b) => b.padEnd(15)).join('') + 'comb   danno dB (corr) per banda');
  for (const [k, v] of Object.entries({ v0: y, v2: xv2, v3: xv3 })) {
    res[k] = echoBandRho(v, SR, d);
    const cc = echoCepstrumComb(v, SR, d); res[k].comb = cc.ratio;
    const dm = echoBandDamage(y, v, SR);
    console.log(k.padEnd(9) + res[k].map((r) => r.map((q) => q.toFixed(2)).join('/').padEnd(15)).join('') + cc.ratio.toFixed(1).padEnd(7) + dm.map((q) => `${q.lossDb.toFixed(2)}(${q.corr.toFixed(2)})`).join(' '));
    res[k].dmg = dm;
  }
  assert.ok(res.v3[2][0] < 0.8 * res.v2[2][0], 'v3: rho(d) 2-6k sotto v2');
  for (let b = 0; b < 4; b++) {
    assert.ok(res.v3[b][0] < res.v0[b][0], `v3: rho(d) scende nella banda ${bandNames[b]}`);
    assert.ok(res.v3[b][0] < res.v2[b][0] + 0.04, `v3: banda ${bandNames[b]} non peggio di v2`);
    assert.ok(res.v3[b][1] < 0.15 && res.v3[b][2] < 0.15, `v3: niente picchi a 2d/3d banda ${bandNames[b]}`);
    assert.ok(res.v3.dmg[b].lossDb > -4 && res.v3.dmg[b].corr > 0.8, `v3: non svuota la banda ${bandNames[b]}`);
  }
  assert.ok(res.v3.comb < res.v0.comb, 'v3: comb < v0');
  let pk3 = 0; for (const c of xv3) for (const v of c) pk3 = Math.max(pk3, Math.abs(v));
  assert.ok(pk3 <= 1);
  assert.ok(t3 < 1000, 'v3 >= 10x realtime'); // soglia larga: il container condiviso oscilla attorno a 20x (falsi fallimenti)
  {
    const n = xv3[0].length, b = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { b[2 * i] = xv3[0][i]; b[2 * i + 1] = xv3[1][i]; }
    const e = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', '-', '-c:a', 'aac', '-b:a', '256k', '/tmp/claude-0/lab/7440_v3.m4a'], { input: Buffer.from(b.buffer) });
    assert.equal(e.status, 0, e.stderr?.toString());
    console.log('scritto /tmp/claude-0/lab/7440_v3.m4a');
  }

  // streaming == batch con blocchi dispari; la somma delle uscite pareggia l'ingresso (latenza gestita da flush)
  {
    const rem = createEchoRemoverV3({ delaySamples: d, sampleRate: SR, channels: 2 });
    const outs = [[], []]; let p = 0, got = 0;
    for (const n of [1000, 7, 4096, 333, 33333, 1e9]) {
      const e = Math.min(y[0].length, p + n); if (e <= p) break;
      const o = rem.process(y.map((c) => c.subarray(p, e)));
      outs[0].push(o[0]); outs[1].push(o[1]); p = e; got += o[0].length;
      assert.ok(got >= p - rem.latency - rem.hop && got <= p, 'ritardo di emissione <= latency + hop');
    }
    const f = rem.flush(); outs[0].push(f[0]); outs[1].push(f[1]);
    let maxd = 0;
    for (let c = 0; c < 2; c++) { let off = 0; for (const pc of outs[c]) { for (let i = 0; i < pc.length; i++) maxd = Math.max(maxd, Math.abs(pc[i] - xv3[c][off + i])); off += pc.length; } assert.equal(off, y[c].length); }
    console.log(`v3 streaming vs batch max diff = ${maxd} (latenza ${rem.latency} campioni = ${(rem.latency / SR * 1000).toFixed(1)} ms, compensata da flush)`);
    assert.ok(maxd < 1e-6);
  }

  // controlli negativi: nessun eco -> v3 quasi trasparente (< 0.5 dB per banda)
  const negs = { 'sintetico (rosa+tono)': syn, '2147 (audio reale senza eco)': y2 };
  for (const [nm, sig] of Object.entries(negs)) {
    const xn = removeEchoV3(sig, SR, { delaySamples: d });
    const dm = echoBandDamage(sig, xn, SR);
    console.log(`negativo v3 ${nm}: perdita dB per banda ${dm.map((q) => q.lossDb.toFixed(2)).join('/')} corr ${dm.map((q) => q.corr.toFixed(3)).join('/')}`);
    for (let b = 0; b < 4; b++) assert.ok(Math.abs(dm[b].lossDb) < 0.5 && dm[b].corr > 0.97, `negativo v3 ${nm}: banda ${bandNames[b]} trasparente`);
  }
  // mono e 3 canali non devono rompersi
  const m1 = removeEchoV3([y[0].subarray(0, SR * 3)], SR, { delaySamples: d });
  const m3 = removeEchoV3([y[0].subarray(0, SR * 3), y[1].subarray(0, SR * 3), y[0].subarray(0, SR * 3)], SR, { delaySamples: d });
  assert.ok(m1.length === 1 && m3.length === 3 && m1[0].length === SR * 3 && m3[2].length === SR * 3);
}

// 3d. v4: deconvoluzione MIMO di Wiener non causale, filtro stimato alla cieca sull'intero file
{
  const bandNames = ['<500', '0.5-2k', '2-6k', '>6k'];
  // --- sintetico: eco MIMO con termini incrociati L<->R, |B| ~ |A| (l'inverso ricorsivo causale e' instabile) ---
  const D0 = 1841, n0 = SR * 12;
  const sx = [pink(n0, 21), pink(n0, 22)];
  const tapsB = [[[0.55, 0.3, 0.1, -0.1], [0.5, 0.25, 0.0, -0.1]], [[-0.6, -0.2, 0.15, 0.0], [0.6, 0.3, -0.1, 0.05]]]; // B[i][j] = FIR a D0, D0+1, ...
  const sy = sx.map((c, i) => { const o = new Float32Array(c); for (let j = 0; j < 2; j++) for (let k = 0; k < 4; k++) { const g = tapsB[i][j][k]; for (let t = D0 + k; t < n0; t++) o[t] += g * sx[j][t - D0 - k]; } return o; });
  const sdet4 = detectEcho(sy, SR);
  assert.ok(sdet4.found && Math.abs(sdet4.delaySamples - D0) < 3, 'rileva eco MIMO sintetico');
  const err = (z) => { let e = 0, p = 0; for (let c = 0; c < 2; c++) for (let i = 4000; i < n0 - 4000; i++) { const dd = z[c][i] - sx[c][i]; e += dd * dd; p += sx[c][i] * sx[c][i]; } return 10 * Math.log10(e / p); };
  const t4 = performance.now();
  const sz = removeEchoV4(sy, SR, { delaySamples: sdet4.delaySamples });
  const ms4 = performance.now() - t4;
  console.log(`v4 sintetico MIMO |B|~|A|: errore vs pulito  y ${err(sy).toFixed(1)} dB -> v4 ${err(sz).toFixed(1)} dB  (${ms4.toFixed(0)} ms per ${(n0 / SR).toFixed(0)} s)`);
  assert.ok(err(sz) < err(sy) - 8, 'v4: eco sintetico MIMO ridotto di > 8 dB');
  assert.equal(sz[0].length, n0);
  // negativo: nessuna eco. Sintetico: v4 quasi trasparente. Audio reale pulito: lo stimatore puo' scambiare la periodicita'
  // naturale per eco (nessun controllo interno): v4 si applica SOLO se detectEcho trova l'eco (qui found=false, vedi sopra)
  {
    const xn = removeEchoV4(syn, SR, { delaySamples: d });
    const dm = echoBandDamage(syn, xn, SR);
    console.log(`negativo v4 sintetico (rosa+tono): perdita dB per banda ${dm.map((q) => q.lossDb.toFixed(2)).join('/')} corr ${dm.map((q) => q.corr.toFixed(3)).join('/')}`);
    for (let b = 0; b < 4; b++) assert.ok(Math.abs(dm[b].lossDb) < 1.5 && dm[b].corr > 0.9, `negativo v4 sintetico: banda ${bandNames[b]} quasi trasparente`);
    const x2 = removeEchoV4(y2, SR, { delaySamples: d });
    const dm2 = echoBandDamage(y2, x2, SR);
    console.log(`(info) v4 forzato su 2147 senza eco (found=${d2.found}, non verrebbe applicato): perdita dB per banda ${dm2.map((q) => q.lossDb.toFixed(2)).join('/')}`);
    assert.ok(x2.every((c) => c.every(Number.isFinite)));
  }
  // --- robustezza: mono, 3 canali, silenzio, priming a zero, clip corte ---
  const L3 = SR * 4;
  const m1 = removeEchoV4([sy[0].subarray(0, L3)], SR, { delaySamples: D0 });
  const m3 = removeEchoV4([sy[0].subarray(0, L3), sy[1].subarray(0, L3), sy[0].subarray(0, L3)], SR, { delaySamples: D0 });
  assert.ok(m1.length === 1 && m3.length === 3 && m1[0].length === L3 && m3[2].length === L3, 'forma uscita mono/3 canali');
  const zeros = [new Float32Array(SR * 3), new Float32Array(SR * 3)];
  const zz = removeEchoV4(zeros, SR, { delaySamples: D0 });
  assert.ok(zz.every((c) => c.every((v) => v === 0)), 'silenzio -> silenzio, niente NaN');
  const prim = sy.map((c) => { const o = new Float32Array(c.length + 2048); o.set(c, 2048); return o; });
  const zp = removeEchoV4(prim, SR, { delaySamples: D0 });
  assert.ok(zp.every((c) => c.every(Number.isFinite)), 'priming a zero: nessun NaN');
  const sh = removeEchoV4(sy.map((c) => c.subarray(0, 8000)), SR, { delaySamples: D0 });
  assert.ok(sh[0].length === 8000 && sh[0].every(Number.isFinite), 'clip corta: copia senza errori');
  // stimatore/applicatore separati == batch
  const est = estimateEchoV4(sy, SR, { delaySamples: D0 });
  const ap = applyEchoV4(sy, SR, est, { delaySamples: D0 });
  const full = removeEchoV4(sy, SR, { delaySamples: D0 });
  let md = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < n0; i++) md = Math.max(md, Math.abs(ap[c][i] - full[c][i]));
  assert.ok(md < 1e-6 && est.estimated && est.iterations === 5);

  // --- audio reale IMG_7440 (nel repo, senza riferimento pulito): rho per banda, comb, danno vs v3 ---
  const t3r = performance.now(); const v3r = removeEchoV3(y, SR, { delaySamples: d }); const m3ms = performance.now() - t3r;
  const t4r = performance.now(); const v4r = removeEchoV4(y, SR, { delaySamples: d }); const m4ms = performance.now() - t4r;
  console.log(`7440 (${(y[0].length / SR).toFixed(1)} s): v3 ${m3ms.toFixed(0)} ms, v4 ${m4ms.toFixed(0)} ms`);
  console.log('modo     ' + bandNames.map((b) => b.padEnd(15)).join('') + 'comb   danno vs y dB (corr) per banda');
  const r4 = {};
  for (const [k, v] of Object.entries({ v0: y, v3: v3r, v4: v4r })) {
    r4[k] = echoBandRho(v, SR, d); const cc = echoCepstrumComb(v, SR, d); r4[k].comb = cc.ratio;
    const dm = echoBandDamage(y, v, SR);
    console.log(k.padEnd(9) + r4[k].map((r) => r.map((q) => q.toFixed(2)).join('/').padEnd(15)).join('') + cc.ratio.toFixed(1).padEnd(7) + dm.map((q) => `${q.lossDb.toFixed(2)}(${q.corr.toFixed(2)})`).join(' '));
  }
  for (let b = 0; b < 4; b++) assert.ok(r4.v4[b][0] < r4.v0[b][0] + 1e-9 && (b === 3 || r4.v4[b][0] < 0.5 * r4.v0[b][0]), `v4: rho(d) scende nella banda ${bandNames[b]}`);
  assert.ok(r4.v4.comb < r4.v0.comb, 'v4: comb < v0');
  let pk4 = 0; for (const c of v4r) for (const v of c) pk4 = Math.max(pk4, Math.abs(v));
  assert.ok(pk4 <= 1 && v4r.every((c) => c.every(Number.isFinite)));

  // --- prestazioni: 60 s stereo @ 48 kHz (due coppie concatenate) ---
  {
    const nP = 48000 * 60, big = [new Float32Array(nP), new Float32Array(nP)];
    for (let i = 0; i < nP; i++) { big[0][i] = sy[0][i % n0] * 0.9; big[1][i] = sy[1][i % n0] * 0.9; }
    if (global.gc) global.gc();
    const rss0 = process.memoryUsage().rss, tp = performance.now();
    const zbig = removeEchoV4(big, 48000, { delaySamples: 2005 });
    const msP = performance.now() - tp, rss1 = process.resourceUsage().maxRSS / 1024;
    console.log(`perf v4: ${msP.toFixed(0)} ms per 60 s stereo 48 kHz; RSS prima ${(rss0 / 1e6).toFixed(0)} MB, picco ${rss1.toFixed(0)} MB (di cui I/O 2x23 MB)`);
    assert.ok(zbig[0].length === nP && msP < 60000);
  }

  // --- coppie di riferimento (verita' di campo: audio pulito x e rovinato y, 48 kHz stereo); file PRIVATI solo in /tmp ---
  function readNpy(p) {
    const b = fs.readFileSync(p), hl = b.readUInt16LE(8), hdr = b.subarray(10, 10 + hl).toString();
    const sh2 = /'shape': \((\d+), (\d+)\)/.exec(hdr), nn = +sh2[1], cc = +sh2[2];
    if (!/<f8/.test(hdr) || cc !== 2) throw new Error('npy non supportato');
    const dat = new Float64Array(b.buffer.slice(b.byteOffset + 10 + hl, b.byteOffset + 10 + hl + nn * cc * 8));
    return [0, 1].map((j) => { const ch = new Float32Array(nn); for (let i = 0; i < nn; i++) ch[i] = dat[i * cc + j]; return ch; });
  }
  // echo_level (tools/lab/echo_lab.py): regressione di z sul pulito x (taps +-48 campioni = diretto; 35-50 ms = copia ritardata),
  // dB(copia/diretto) per canale. Qui colonne 'copia' a passo 16 (lab: 4): +-0.6 dB circa dal valore del lab.
  function makeEchoLevel(xr, sr = 48000, estep = 16) {
    const n = xr[0].length, S = 3000, E = n - 3000, len = E - S, cols = [];
    for (let i = 0; i < 2; i++) {
      for (let k = -48; k <= 48; k += 4) cols.push({ i, k, e: false });
      for (let k = Math.floor(0.035 * sr); k < Math.floor(0.05 * sr); k += estep) cols.push({ i, k, e: true });
    }
    const nc2 = cols.length;
    const C = cols.map((c) => { const a = new Float64Array(len); for (let t = 0; t < len; t++) a[t] = xr[c.i][(((S + t - c.k) % n) + n) % n]; return a; });
    const G = new Float64Array(nc2 * nc2);
    for (let p = 0; p < nc2; p++) for (let q = 0; q <= p; q++) { let a = 0; const u = C[p], v = C[q]; for (let t = 0; t < len; t++) a += u[t] * v[t]; G[p * nc2 + q] = G[q * nc2 + p] = a; }
    let tr = 0; for (let p = 0; p < nc2; p++) tr += G[p * nc2 + p];
    const Lc = Float64Array.from(G); for (let p = 0; p < nc2; p++) Lc[p * nc2 + p] += (1e-12 * tr) / nc2;
    for (let i = 0; i < nc2; i++) for (let j = 0; j <= i; j++) { let a = Lc[i * nc2 + j]; for (let k = 0; k < j; k++) a -= Lc[i * nc2 + k] * Lc[j * nc2 + k]; if (i === j) Lc[i * nc2 + i] = Math.sqrt(Math.max(a, 1e-300)); else Lc[i * nc2 + j] = a / Lc[j * nc2 + j]; }
    return (z) => [0, 1].map((o) => {
      const b = new Float64Array(nc2); for (let p = 0; p < nc2; p++) { let a = 0; const u = C[p]; for (let t = 0; t < len; t++) a += u[t] * z[o][S + t]; b[p] = a; }
      const w = new Float64Array(nc2), c = new Float64Array(nc2);
      for (let i = 0; i < nc2; i++) { let a = b[i]; for (let k = 0; k < i; k++) a -= Lc[i * nc2 + k] * w[k]; w[i] = a / Lc[i * nc2 + i]; }
      for (let i = nc2 - 1; i >= 0; i--) { let a = w[i]; for (let k = i + 1; k < nc2; k++) a -= Lc[k * nc2 + i] * c[k]; c[i] = a / Lc[i * nc2 + i]; }
      let ed = 0, ee = 0;
      for (let p = 0; p < nc2; p++) for (let q = 0; q < nc2; q++) if (cols[p].e === cols[q].e) { const v = c[p] * c[q] * G[p * nc2 + q]; if (cols[p].e) ee += v; else ed += v; }
      return Math.round(10 * Math.log10(ee / ed) * 10) / 10;
    });
  }
  const LAB = '/tmp/claude-0/lab', pairs = { e2790: { l: -4.5, r: -9.5 }, e2813: { l: -8.5, r: -11.5 } }; // soglie di accettazione v4 (L, R)
  for (const [name, thr] of Object.entries(pairs)) {
    const px = `${LAB}/${name}/x.npy`, py = `${LAB}/${name}/y.npy`;
    if (!fs.existsSync(px) || !fs.existsSync(py)) { console.log(`SKIP coppia ${name}: file di riferimento assenti (${px}, ${py})`); continue; }
    const rx = readNpy(px), ry = readNpy(py), SR48 = 48000;
    const dY = detectEcho(ry, SR48), dX = detectEcho(rx, SR48);
    console.log(`${name}: detectEcho(y) found=${dY.found} d=${dY.delayMs.toFixed(2)} ms rho=${dY.rho.toFixed(3)} cons=${dY.consistency.toFixed(2)} | detectEcho(x pulito) found=${dX.found} rho=${dX.rho.toFixed(3)} cons=${dX.consistency.toFixed(2)}`);
    assert.ok(dY.found && Math.abs(dY.delayMs - 41.8) < 0.5, `${name}: eco rilevata su y`);
    assert.ok(!dX.found, `${name}: nessuna eco sull'audio pulito`);
    const lv = makeEchoLevel(rx);
    const tq = performance.now(); const zr = removeEchoV4(ry, SR48, { delaySamples: dY.delaySamples }); const mq = performance.now() - tq;
    const lY = lv(ry), lZ = lv(zr), dmg = echoBandDamage(rx, zr, SR48);
    console.log(`${name}: echo_level (L,R)  rovinato ${lY.join('/')}  v4 ${lZ.join('/')} dB (${mq.toFixed(0)} ms per ${(rx[0].length / SR48).toFixed(1)} s); livello vs pulito per banda ${bandNames.map((b, i) => `${b} ${dmg[i].lossDb.toFixed(1)}`).join(' ')} dB`);
    assert.ok(lZ[0] < lY[0] - 5 && lZ[1] < lY[1] - 5, `${name}: v4 riduce l'eco di > 5 dB`);
    assert.ok(lZ[0] <= thr.l && lZ[1] <= thr.r, `${name}: v4 eco residua <= soglia (${thr.l}/${thr.r})`);
    for (let b = 0; b < 4; b++) assert.ok(dmg[b].lossDb > -5 && dmg[b].lossDb < 4, `${name}: danno spettrale banda ${bandNames[b]} nei limiti`);
  }
}

// 4. uscita per ascolto
const buf = new Float32Array(x[0].length * 2);
for (let i = 0; i < x[0].length; i++) { buf[2 * i] = x[0][i]; buf[2 * i + 1] = x[1][i]; }
const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', '-', '-c:a', 'aac', '-b:a', '192k', '/tmp/claude-0/lab/7440_fixed.m4a'],
  { input: Buffer.from(buf.buffer) });
assert.equal(enc.status, 0, enc.stderr?.toString());
console.log('scritto /tmp/claude-0/lab/7440_fixed.m4a');
console.log('OK');
