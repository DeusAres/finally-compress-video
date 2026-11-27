// Test Node della modalità SDR (v0.38): riordino per pts, timestamp, pipeline decoder → convertitore, risoluzioni, manifest con mode/res.
// Uso: node app/lib/sdrpath.test.mjs
import assert from 'node:assert/strict';
const { nearestIndex, createReorder, frameTiming, sdrWindow, scaleTaps, nv12Stride, sdrCodec, decodeOrdered, convertOrdered, _wgsl } = await import('./sdrpath.js');
const { resDims, sdrRes, verifyDownscale, sdrDsError, SDR_DS_MESSAGE } = await import('./downscale.js');
const { sameVideoSettings, videoMode, videoRes } = await import('./jobstore.js');
const { estimateTimeS, speedKey } = await import('../ui/estimate.js');

// 1) ricerca del pts più vicino con tolleranza (l'encoder/decoder di Safari arrotonda a 90 kHz)
{
  const L = [0, 16667, 33333, 50000];
  assert.equal(nearestIndex(L, 16600), 1); assert.equal(nearestIndex(L, 33400), 2); assert.equal(nearestIndex(L, 60000), -1); assert.equal(nearestIndex(L, -900), -1);
  assert.equal(nearestIndex([], 0), -1);
  console.log('ok 1 nearestIndex');
}
// 2) riordino: ordine di decodifica (I P B B …) → ordine dei pts; frame fuori intervallo e doppioni rifiutati
{
  const want = [100, 200, 300, 400, 500], ro = createReorder(want, 10), out = [];
  for (const ts of [100, 400, 200, 300, 50, 500, 400, 900]) { if (!ro.put(ts, ts)) out.push('x' + ts); for (let v; (v = ro.take()) != null;) out.push(v); }
  assert.deepEqual(out, [100, 200, 300, 400, 'x50', 500, 'x400', 'x900']);
  assert.ok(ro.done); assert.equal(ro.put(100, 1), false, 'già consegnato');
  console.log('ok 2 riordino');
}
// 3) timestamp: pts sorgente (VFR rispettato), durata mai 0; finestra bitrate; prese/stride dello shader; codec
{
  assert.deepEqual(frameTiming({ ts: 1234567, dur: 16683 }), { timestamp: 1234567, duration: 16683 });
  assert.equal(frameTiming({ ts: 5, dur: 0 }).duration, 1);
  assert.equal(sdrWindow(60), 30); assert.equal(sdrWindow(120), 60); assert.equal(sdrWindow(0), 30);
  assert.equal(scaleTaps(1920, 1080, 1920, 1080), 0); assert.equal(scaleTaps(3840, 2160, 1920, 1080), 2); assert.equal(scaleTaps(1920, 1080, 1280, 720), 2); assert.equal(scaleTaps(3840, 2160, 960, 540), 4);
  assert.equal(nv12Stride(854), 856); assert.equal(nv12Stride(1920), 1920);
  assert.equal(sdrCodec('hevc', 1920, 1080), 'hvc1.1.6.L123.B0'); assert.equal(sdrCodec('hevc', 3840, 2160), 'hvc1.1.6.L153.B0'); assert.equal(sdrCodec('avc', 1, 1), 'avc1.640033');
  assert.ok(_wgsl.WGSL.includes('texture_external') && _wgsl.WGSL_COPY.includes('texture_2d<f32>') && _wgsl.WGSL_COPY.includes('textureSampleLevel') && !_wgsl.WGSL_COPY.includes('texture_external'));
  console.log('ok 3 timestamp, finestra, shader, codec');
}

// decoder finto: emette i frame con un ritardo di riordino (ordine di decodifica ≠ presentazione), apre/chiude VideoFrame contati
const open = new Set();
class FakeFrame { constructor(ts) { this.timestamp = ts; open.add(this); } close() { open.delete(this); } }
class FakeDecoder {
  constructor({ output, error }) { this.o = output; this.e = error; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.buf = []; }
  configure() { this.state = 'configured'; }
  decode(c) { if (c.fail) { setTimeout(() => this.e(new Error('decoder rotto'))); return; } this.buf.push(c.timestamp); this.buf.sort((a, b) => a - b); if (this.buf.length > 2) { const t = this.buf.shift(); setTimeout(() => this.o(new FakeFrame(t))); } }
  async flush() { await new Promise((r) => setTimeout(r)); for (const t of this.buf.splice(0)) this.o(new FakeFrame(t)); await new Promise((r) => setTimeout(r)); }
  close() { this.state = 'closed'; }
}
// sorgente IPBB: pts 0..n-1 (×1000), ordine di decodifica con B-frame (0, 3, 1, 2, 6, 4, 5, …)
const decOrder = (n) => { const o = []; for (let g = 0; g < n; g += 3) { o.push(g); if (g + 3 < n) o.push(g + 3); else for (let k = g + 1; k < n; k++) o.push(k); if (g + 3 < n) { o.push(g + 1, g + 2); g += 0; } } return [...new Set(o)].filter((x) => x < n); };
async function* chunks(n, { failAt = -1 } = {}) { for (const [i, p] of decOrder(n).entries()) { await new Promise((r) => setTimeout(r)); yield { timestamp: p * 1000, fail: i === failAt }; } }
const conv = { depth: 4, submit: (f, fr) => new Promise((r) => setTimeout(() => { const v = new FakeFrame(fr.ts); v.duration = fr.dur; f.close(); r(v); }, Math.random() * 3)) };

// 4) pipeline completa da metà sorgente (ripresa a segmenti): frame in ordine, pts e durate dalla lista, nessun frame aperto
{
  const list = Array.from({ length: 20 }, (_, i) => ({ ts: (i + 7) * 1000, dur: 1000 + i }));
  const st = {}, dec = decodeOrdered({ chunks: chunks(40), config: {}, wantUs: list.map((f) => f.ts), stats: st, Decoder: FakeDecoder, ahead: 3 });
  const got = []; for await (const vf of convertOrdered(dec, conv, list, st)) { got.push([vf.timestamp, vf.duration]); vf.close(); }
  assert.deepEqual(got, list.map((f) => [f.ts, f.dur]));
  assert.ok(st.ooo > 0, 'il decoder finto emette fuori ordine'); assert.ok(st.extra >= 7, 'frame prima dell\'intervallo chiusi');
  await new Promise((r) => setTimeout(r, 20)); assert.equal(open.size, 0, 'frame rimasti aperti');
  console.log(`ok 4 pipeline ordinata (fuori ordine ${st.ooo}, scartati ${st.extra})`);
}
// 5) interruzione (background) a metà: BackgroundInterrupt, nessun frame aperto; errore del decoder propagato
{
  const list = Array.from({ length: 30 }, (_, i) => ({ ts: i * 1000, dur: 1000 })), ac = new AbortController();
  const dec = decodeOrdered({ chunks: chunks(30), config: {}, wantUs: list.map((f) => f.ts), signal: ac.signal, Decoder: FakeDecoder });
  let n = 0;
  await assert.rejects((async () => { for await (const vf of convertOrdered(dec, conv, list, null, ac.signal)) { vf.close(); if (++n === 5) ac.abort(); } })(), (e) => e.name === 'BackgroundInterrupt');
  const dec2 = decodeOrdered({ chunks: chunks(30, { failAt: 6 }), config: {}, wantUs: list.map((f) => f.ts), Decoder: FakeDecoder });
  await assert.rejects((async () => { for await (const vf of convertOrdered(dec2, conv, list)) vf.close(); })(), /decoder rotto/);
  // frame mancante: la sorgente finisce prima → errore esplicito, non un file corto
  const dec3 = decodeOrdered({ chunks: chunks(10), config: {}, wantUs: [...list.slice(0, 10).map((f) => f.ts), 99000], Decoder: FakeDecoder });
  await assert.rejects((async () => { for await (const vf of convertOrdered(dec3, conv, [...list.slice(0, 10), { ts: 99000, dur: 1 }])) vf.close(); })(), (e) => e.name === 'SdrMissingFrames');
  await new Promise((r) => setTimeout(r, 30)); assert.equal(open.size, 0, 'frame rimasti aperti');
  console.log('ok 5 interruzione, errore decoder, frame mancante');
}
// 6) risoluzioni SDR: lato corto a scelta, proporzioni, pari, mai ingrandire; downscale = alias di 1080
{
  assert.deepEqual(resDims(3840, 2160, 1080), { width: 1920, height: 1080, exact: true });
  assert.deepEqual(resDims(1920, 1080, 720), { width: 1280, height: 720, exact: true });
  assert.deepEqual(resDims(1080, 1920, 540), { width: 540, height: 960, exact: true });
  const r480 = resDims(1920, 1080, 480); assert.deepEqual([r480.width, r480.height], [854, 480]); assert.equal(r480.exact, false);
  assert.equal(resDims(1920, 1080, 1080), null); assert.equal(resDims(1920, 1080, 1440), null); assert.equal(resDims(3840, 2160, null), null);
  assert.equal(sdrRes({ res: 'orig' }), null); assert.equal(sdrRes({ res: 720 }), 720); assert.equal(sdrRes({ res: '540' }), 540); assert.equal(sdrRes({ downscale: true }), 1080); assert.equal(sdrRes({ res: 'orig', downscale: true }), null);
  // verifica dell'encoder in SDR: 8 bit attesi (un hvcC a 10 bit non va bene)
  const SAFARI_HVCC = '010220000000b0000000000078f000fcfdfafa00000f04a00001001840010c01ffff022000000300b00000030000030078170240a100010023420101022000000300b00000030000030078a00220801e072ed8817924591572e5cba2a2000100074401c0764c14c9a70001000d4e019408002fe9a03d13404280';
  const v = verifyDownscale(Uint8Array.from(Buffer.from(SAFARI_HVCC, 'hex')), { width: 1080, height: 1920, bitDepth: 8 });
  assert.ok(!v.ok); assert.match(v.why, /invece di 8/);
  const e = sdrDsError('x'); assert.equal(e.name, 'DownscaleError'); assert.equal(e.message, SDR_DS_MESSAGE); assert.ok(e.sdr);
  console.log('ok 6 risoluzioni SDR e verifica a 8 bit');
}
// 7) manifest: modalità e risoluzione SDR nelle impostazioni → una ripresa con modalità/risoluzione diversa non riusa i segmenti
{
  const base = { bitrateMbps: 8, keyframeS: 4, sceneQ: true, downscale: false };
  assert.ok(sameVideoSettings(base, { ...base, mode: 'hdr' }), 'manifest vecchio (senza mode) = hdr');
  assert.ok(!sameVideoSettings({ ...base, mode: 'hdr' }, { ...base, mode: 'sdr' }));
  assert.ok(sameVideoSettings({ ...base, mode: 'sdr', res: 'orig' }, { ...base, mode: 'sdr' }));
  assert.ok(!sameVideoSettings({ ...base, mode: 'sdr', res: '720' }, { ...base, mode: 'sdr', res: 1080 }));
  assert.ok(sameVideoSettings({ ...base, mode: 'sdr', res: '720' }, { ...base, mode: 'sdr', res: 720 }));
  assert.ok(sameVideoSettings({ ...base, mode: 'hdr', res: '720' }, { ...base, mode: 'hdr', res: 'orig' }), 'in HDR res non conta');
  assert.equal(videoMode({}), 'hdr'); assert.equal(videoRes({ mode: 'sdr', downscale: true }), '1080');
  console.log('ok 7 manifest con mode/res');
}
// 8) stima del tempo SDR: 250 fps a 1080p (misurato), 4K ipotesi; qualità per scena ignorata
{
  const t = estimateTimeS({ durS: 10, fps: 60, mode: 'sdr', width: 1920, height: 1080, sceneQ: true });
  assert.equal(t.fps, 250); assert.equal(t.variable, false); assert.equal(t.guess, false); assert.ok(Math.abs(t.s - (1 + 600 / 250 * 1.03)) < 1e-9);
  const u = estimateTimeS({ durS: 10, fps: 30, mode: 'sdr', width: 3840, height: 2160 }); assert.ok(u.guess); assert.equal(u.fps, 70);
  assert.equal(estimateTimeS({ durS: 10, fps: 30, mode: 'sdr', width: 3840, height: 2160, res: 720 }).fps, 160);
  assert.equal(speedKey({ mode: 'sdr', width: 1920, height: 1080 }), 'fcv.fps.sdr.hd');
  assert.equal(speedKey({ par2: true, width: 1920, height: 1080 }), 'fcv.fps.p2.hd', 'HDR invariato');
  console.log('ok 8 stima tempo SDR');
}
console.log('sdrpath: tutti ok');
