// Test Node della modalità SDR (v0.38): riordino per pts, timestamp, pipeline decoder → convertitore, risoluzioni, manifest con mode/res.
// Uso: node app/lib/sdrpath.test.mjs
import assert from 'node:assert/strict';
const { openSdrSource, srcStartOrder, nalTypes, createDirectConverter, nearestIndex, createReorder, frameTiming, sdrWindow, scaleTaps, nv12Stride, sdrCodec, decodeOrdered, convertOrdered, _wgsl, lutToHalf, loadLutData, LUT } = await import('./sdrpath.js');
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

// decoder finto: emette i frame in ORDINE DI DECODIFICA (come Safari: 135 su 271 fuori ordine), con 2 frame di ritardo, apre/chiude VideoFrame contati
const open = new Set();
class FakeFrame { constructor(ts) { this.timestamp = ts; open.add(this); } close() { open.delete(this); } }
class FakeDecoder {
  constructor({ output, error }) { this.o = output; this.e = error; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.buf = []; }
  configure() { this.state = 'configured'; }
  decode(c) { if (c.fail) { setTimeout(() => this.e(new Error('decoder rotto'))); return; } this.buf.push(c.timestamp); if (this.buf.length > 2) { const t = this.buf.shift(); setTimeout(() => this.o(new FakeFrame(t))); } }
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
  assert.equal(sdrRes({ res: 'orig' }), null); assert.equal(sdrRes({ res: 720 }), 720); assert.equal(sdrRes({ res: '540' }), 540); assert.equal(sdrRes({ downscale: true }), 1080); assert.equal(sdrRes({ res: 'orig', downscale: true }), 1080, 'downscale = alias di 1080');
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
// 8) stima del tempo SDR: 250 fps a 1080p (misurato), 4K ipotesi; v0.39 qualità per scena: + prove (×1.6 come in HDR)
{
  const t = estimateTimeS({ durS: 10, fps: 60, mode: 'sdr', width: 1920, height: 1080 });
  assert.equal(t.fps, 250); assert.equal(t.variable, false); assert.equal(t.guess, false); assert.ok(Math.abs(t.s - (1 + 600 / 250 * 1.03)) < 1e-9);
  const q = estimateTimeS({ durS: 10, fps: 60, mode: 'sdr', width: 1920, height: 1080, sceneQ: true });
  assert.equal(q.variable, true); assert.ok(Math.abs(q.s - (1 + 600 / 250 * 1.6 * 1.03)) < 1e-9, `${q.s}`);
  assert.equal(estimateTimeS({ durS: 10, fps: 60, mode: 'hdr8', width: 1920, height: 1080, sceneQ: true }).variable, true);
  const u = estimateTimeS({ durS: 10, fps: 30, mode: 'sdr', width: 3840, height: 2160 }); assert.ok(u.guess); assert.equal(u.fps, 70);
  assert.equal(estimateTimeS({ durS: 10, fps: 30, mode: 'sdr', width: 3840, height: 2160, res: 720 }).fps, 160);
  assert.equal(speedKey({ mode: 'sdr', width: 1920, height: 1080 }), 'fcv.fps.sdr.hd');
  assert.equal(speedKey({ par2: true, width: 1920, height: 1080 }), 'fcv.fps.p2.hd', 'HDR invariato');
  console.log('ok 8 stima tempo SDR');
}
// 9) HDR veloce 8 bit ('hdr8'): frame diretti col pts sorgente, manifest e stima distinti da sdr/hdr
{
  globalThis.VideoFrame = class { constructor(src, o) { this.timestamp = o.timestamp; this.duration = o.duration; this.src = src; } close() {} };
  let closed = 0; const f = { close: () => closed++ };
  const v = await createDirectConverter().submit(f, { ts: 4242, dur: 16683 });
  assert.equal(v.src, f); assert.equal(v.timestamp, 4242); assert.equal(v.duration, 16683); assert.equal(closed, 1, 'frame del decoder chiuso');
  const base = { bitrateMbps: 8, keyframeS: 4 };
  assert.ok(!sameVideoSettings({ ...base, mode: 'hdr8' }, { ...base, mode: 'sdr' })); assert.ok(!sameVideoSettings({ ...base, mode: 'hdr8' }, base));
  assert.equal(videoRes({ mode: 'hdr8', res: 720 }), '720');
  const t = estimateTimeS({ durS: 10, fps: 60, mode: 'hdr8', width: 1920, height: 1080 }); assert.equal(t.fps, 257); assert.equal(t.guess, false);
  assert.equal(speedKey({ mode: 'hdr8', width: 3840, height: 2160, downscale: true }), 'fcv.fps.hdr8.uhd.ds');
  console.log('ok 9 hdr8');
}
{
  // 3D LUT Apple: dimensione, conversione half, ripiego su Hable se manca
  const { readFileSync } = await import('node:fs');
  const bin = readFileSync(new URL('../../vendor/lut/apple_hlg_sdr33.bin', import.meta.url));
  assert.equal(bin.byteLength, 33 ** 3 * 3 * 2);
  const half = lutToHalf(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  assert.equal(half.length, 33 ** 3 * 4); assert.equal(half[3], 0x3c00);
  assert.throws(() => lutToHalf(new ArrayBuffer(1000)), /dimensione/);
  assert.ok(_wgsl.WGSL.includes('texture_3d') && _wgsl.WGSL.includes('u.tm>2.5') && _wgsl.WGSL.includes('fn hb('));
  const miss = await loadLutData(async () => { throw new Error('rete'); }, 'x'); assert.ok(!(miss instanceof Uint16Array) && /rete/.test(miss.error));
  const bad = await loadLutData(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(100) }), 'x'); assert.ok(/dimensione/.test(bad.error));
  const good = await loadLutData(async () => ({ ok: true, arrayBuffer: async () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) }), 'x'); assert.ok(good instanceof Uint16Array);
  assert.equal(LUT.n, 33);
  console.log('ok 10 LUT Apple + ripiego Hable');
}
// 11) v0.39.1 avvio a metà file: keyframe CRA con RASL (citano il GOP precedente) → il decoder «WebKit» si chiude al primo errore.
//     HEVC: strategia «lead» (scarta i leading) subito; H.264: «key» fallisce, diagnostica nel log, «lead» adottata e memorizzata.
{
  const fps = 30, G = 30, NG = 3, order = [];
  for (let g = 0; g < NG; g++) { order.push({ pts: g * G, key: true, g }); if (g) order.push({ pts: g * G - 2, g, rasl: true }, { pts: g * G - 1, g, rasl: true }); for (let p = g * G + 1; p < Math.min(NG * G, (g + 1) * G - 2) || (g === NG - 1 && p < NG * G); p++) order.push({ pts: p, g }); }
  const pk = order.map((o) => ({ timestamp: o.pts / fps, type: o.key ? 'key' : 'delta', data: new Uint8Array([0, 0, 0, 2, (o.key ? 21 : o.rasl ? 9 : 1) << 1, 1]), toEncodedVideoChunk: () => ({ timestamp: Math.round(o.pts / fps * 1e6), type: o.key ? 'key' : 'delta', o }) }));
  class Sink { async getFirstPacket() { return pk[0]; } async getKeyPacket(t) { let b = null; for (const p of pk) if (p.type === 'key' && p.timestamp <= t + 1e-9) b = p; return b; } async *packets(k) { for (let i = pk.indexOf(k); i < pk.length; i++) yield pk[i]; } }
  const opened = []; class Dec { constructor({ output, error }) { this.o = output; this.e = error; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.keys = new Set(); opened.push(this); }
    configure() { this.state = 'configured'; }
    decode(c) { if (this.state !== 'configured') throw new Error('chiuso'); if (this.bad) return; const { o } = c; if (o.key) this.keys.add(o.g); if (o.rasl && !this.keys.has(o.g - 1)) { queueMicrotask(() => { this.state = 'closed'; this.e(Object.assign(new Error('Decoder failure'), { name: 'EncodingError' })); }); this.bad = true; return; }
      queueMicrotask(() => this.o({ timestamp: c.timestamp, displayWidth: 64, displayHeight: 36, format: 'NV12', close() {} })); }
    async flush() { await new Promise((r) => setTimeout(r, 2)); } close() { this.state = 'closed'; } }
  globalThis.VideoFrame ??= class { constructor(f, t) { this.timestamp = t.timestamp; this.duration = t.duration; } close() {} };
  const list = (a, b) => Array.from({ length: b - a }, (_, i) => ({ ts: Math.round((a + i) / fps * 1e6), dur: Math.round(1e6 / fps) }));
  const run = async (codec) => {
    const logs = [], src = await openSdrSource({ MB: { EncodedPacketSink: Sink }, track: { getDecoderConfig: async () => ({ codec, description: new Uint8Array(23) }), getColorSpace: async () => ({ transfer: 'hlg' }) }, tonemap: false, log: (t) => logs.push(t), diag: () => 'VideoDecoder aperti 0', Decoder: Dec });
    const take = async (a, b) => { const got = []; for await (const vf of src.frames(list(a, b))) got.push(vf.timestamp); return got; };
    return { logs, take };
  };
  const H = await run('hvc1.1.6.L123.B0');
  assert.deepEqual(await H.take(35, 45), list(35, 45).map((f) => f.ts));
  assert.ok(!H.logs.some((l) => /fallit|non riuscit|Decoder failure/.test(l)), H.logs.join('\n'));
  assert.ok(H.logs.some((l) => /avvio a metà file con la strategia «lead»/.test(l)));
  const A = await run('avc1.640033');
  assert.deepEqual(await A.take(35, 45), list(35, 45).map((f) => f.ts));
  const diag = A.logs.find((l) => /^decoder sorgente: EncodingError: Decoder failure all'avvio della finestra \(strategia «key»\)/.test(l));
  assert.ok(diag && /keyframe 1\.000 s/.test(diag) && /VideoDecoder aperti 0/.test(diag), A.logs.join('\n'));
  assert.ok(A.logs.some((l) => /strategia «lead».*la uso per il resto del job/.test(l)));
  const n0 = A.logs.length; assert.deepEqual(await A.take(65, 70), list(65, 70).map((f) => f.ts)); assert.equal(A.logs.length, n0, 'strategia memorizzata: nessun nuovo tentativo');
  assert.deepEqual(await A.take(0, 5), list(0, 5).map((f) => f.ts));
  await new Promise((r) => setTimeout(r, 10)); assert.ok(opened.every((d) => d.state === 'closed'), 'decoder sorgente sempre chiuso');
  assert.deepEqual(srcStartOrder('hev1.2.4').map((s) => s.id), ['lead', 'key', 'prev', 'first']); assert.equal(srcStartOrder('avc1.64').map((s) => s.id)[0], 'key');
  assert.deepEqual(nalTypes(new Uint8Array([0, 0, 0, 2, 40, 1, 0, 0, 0, 1, 2])), [20, 1]);
  console.log('ok 11 avvio a metà file: leading scartati, strategia memorizzata, diagnostica');
}
console.log('sdrpath: tutti ok');
