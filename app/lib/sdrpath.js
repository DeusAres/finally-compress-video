// Modalità SDR (v0.38): VideoDecoder → WebGPU compute (inversa HLG → OOTF → BT.2020→709 → Hable → OETF BT.709, uscita NV12,
// scalatura opzionale 4K → 1080p nello stesso shader) → VideoFrame NV12 8 bit → encoder HEVC 8 bit.
// Percorso validato su iPhone con tools/diag/sdr8.html v2.1 (IMG_2177 1080p60 HLG): decoder 655 fps, NV12 8 bit con dati HLG grezzi;
// frame del decoder FUORI ORDINE (135/271) → riordino per pts sorgente prima dell'encoder (causa degli scatti); compute + mapAsync con
// 4 frame in volo: 250 fps, gpu 1.8 ms, collo di bottiglia l'encoder. A 8 bit la scalatura su GPU è lecita (in HDR no: research/14).
// Interfaccia come parallelFrames (frames.js): async iterable di VideoFrame per un intervallo di frame [{ts, dur}] in µs, in ordine.
import { interruptError } from './frames.js?v=0.38.1';

export const SDR = { inFlight: 4, decodeAhead: 8, r0: 1.25, minWin: 30, hlgPeakNits: 1000, tolUs: 500 };
export const CS709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
export const VUI709 = { primaries: 1, transfer: 1, matrix: 1, fullRange: false };

// ---------- logica pura (test in Node: app/lib/sdrpath.test.mjs) ----------
/** Indice in `sorted` (µs crescenti) del valore più vicino a ts entro tol, o -1. */
export function nearestIndex(sorted, ts, tol = SDR.tolUs) {
  let lo = 0, hi = sorted.length - 1; if (hi < 0) return -1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < ts) lo = m + 1; else hi = m; }
  const i = lo > 0 && ts - sorted[lo - 1] < sorted[lo] - ts ? lo - 1 : lo;
  return Math.abs(sorted[i] - ts) <= tol ? i : -1;
}
/**
 * Riordino per pts sorgente: i frame arrivano in ordine di decodifica (Safari: 135 su 271 fuori ordine), escono nell'ordine di `wantUs`.
 * put() → false se il frame non è richiesto (prima dell'intervallo, dopo, doppione): il chiamante lo chiude.
 */
export function createReorder(wantUs, tol = SDR.tolUs) {
  const held = new Map(); let k = 0;
  return {
    get next() { return k; }, get size() { return held.size; }, get done() { return k >= wantUs.length; },
    ready: () => held.has(k),
    put(ts, item) { const i = nearestIndex(wantUs, ts, tol); if (i < k || held.has(i)) return false; held.set(i, item); return true; },
    take() { if (!held.has(k)) return null; const it = held.get(k); held.delete(k); k++; return it; },
    drain() { const v = [...held.values()]; held.clear(); return v; },
  };
}
/** Timestamp/durata (µs) del VideoFrame per l'encoder: pts SORGENTE del frame (niente CFR inventato, VFR rispettato). */
export const frameTiming = (f) => ({ timestamp: f.ts, duration: Math.max(1, f.dur) });
/** Finestra del controllo bitrate in SDR: 30 frame o ½ s (sdr8 v2.1: reale/target 0.99 con r0 1.25). */
export const sdrWindow = (fps) => Math.max(SDR.minWin, Math.round((fps > 0 ? fps : 30) / 2));
/** Prese per lato nello shader (media N×N dei pixel sorgente coperti da un pixel di uscita). */
export const scaleTaps = (sw, sh, dw, dh) => (sw === dw && sh === dh ? 0 : Math.max(1, Math.ceil(Math.max(sw / dw, sh / dh) - 1e-9))); // 0 = nessuna scalatura
/** Stride NV12 (byte per riga di Y e di UV): larghezza arrotondata a 4. */
export const nv12Stride = (w) => Math.ceil(w / 4) * 4;
/** Codec 8 bit: HEVC Main (livello 5.1 oltre 2.5 Mpx) o, se il browser non codifica HEVC (Chromium), H.264 solo per prova. */
export const sdrCodec = (kind, w, h) => (kind === 'avc' ? 'avc1.640033' : `hvc1.1.6.L${w * h > 2.5e6 ? 153 : 123}.B0`);
export async function pickSdrCodec(w, h, framerate = 30) {
  try { if ((await VideoEncoder.isConfigSupported({ codec: sdrCodec('hevc', w, h), width: w, height: h, bitrate: 8e6, framerate })).supported) return { kind: 'hevc', codec: sdrCodec('hevc', w, h) }; } catch {}
  return { kind: 'avc', codec: sdrCodec('avc', w, h), extra: { avc: { format: 'avc' } } };
}

// ---------- shader: un'invocazione = 4×2 pixel di uscita (4 byte di Y per riga, 2 coppie UV) ----------
// Scalatura (lato corto a scelta, mai ingrandire): filtro ad AREA con prese bilineari. Per ogni pixel di uscita n×n prese (n = ceil(rapporto))
// distribuite uniformemente sulla sua impronta nella sorgente, ciascuna campionata in bilineare (prefiltro a tenda) nel dominio del
// segnale, poi tone mapping per presa e media nel dominio BT.709. A rapporto intero (2160→1080) le prese cadono sui centri dei texel:
// media 2×2 esatta. Costo ≈ un tone mapping per pixel SORGENTE (come la conversione 1:1 della sorgente). Senza scalatura: textureLoad
// diretto (percorso validato su iPhone). stride = larghezza arrotondata a 4 (NV12 a parole di 4 byte; le colonne in più sono ignorate).
const WGSL = `struct U{src:vec2f,dst:vec2f,tm:f32,lw:f32,taps:f32,stride:f32,mat:f32};
@group(0)@binding(0) var t:texture_external;@group(0)@binding(1) var<uniform> u:U;@group(0)@binding(2) var<storage,read_write> ob:array<u32>;
@group(0)@binding(3) var sp:sampler;
fn ld(p:vec2i)->vec3f{return textureLoad(t,p).rgb;}
fn sm(uv:vec2f)->vec3f{return textureSampleBaseClampToEdge(t,sp,uv).rgb;}
fn hb(x:f32)->f32{return ((x*(0.15*x+0.05)+0.004)/(x*(0.15*x+0.5)+0.06))-0.02/0.3;}
fn hlgi(e:vec3f)->vec3f{let a=0.17883277;let b=0.28466892;let c=0.55991073;let x=clamp(e,vec3f(0),vec3f(1));return select((exp((x-c)/a)+b)/12.0,x*x/3.0,x<=vec3f(0.5));}
fn sdr(c:vec3f)->vec3f{
 if(u.tm<0.5){return c;}
 let sc=hlgi(c);let ys=dot(sc,vec3f(0.2627,0.678,0.0593));
 let d=u.lw*pow(max(ys,1e-6),0.2)*sc;
 let l=max(vec3f(dot(vec3f(1.6605,-0.5876,-0.0728),d),dot(vec3f(-0.1246,1.1329,-0.0083),d),dot(vec3f(-0.0182,-0.1006,1.1187),d)),vec3f(0));
 let sg=max(max(l.r,l.g),max(l.b,1e-6));
 let o=hb(sg/100.0)/hb(u.lw/100.0);
 let v=clamp(l*(o/sg),vec3f(0),vec3f(1));
 return select(1.099*pow(v,vec3f(0.45))-0.099,4.5*v,v<vec3f(0.018));}
fn px(o:vec2u)->vec3f{
 let q=min(o,vec2u(u.dst)-vec2u(1));
 if(u.taps<0.5){return sdr(ld(vec2i(q)));}
 let n=max(1,i32(u.taps));let s=u.src/u.dst;var a=vec3f(0);
 for(var j=0;j<n;j++){for(var i=0;i<n;i++){let p=(vec2f(q)+(vec2f(f32(i),f32(j))+0.5)/f32(n))*s;a+=sdr(sm(p/u.src));}}
 return a/f32(n*n);}
fn q8(v:f32)->u32{return u32(clamp(round(v),0.0,255.0));}
fn kw()->vec3f{if(u.mat>0.5){return vec3f(0.2627,0.678,0.0593);}return vec3f(0.2126,0.7152,0.0722);}
fn kb()->f32{if(u.mat>0.5){return 1.8814;}return 1.8556;}
fn kr()->f32{if(u.mat>0.5){return 1.4746;}return 1.5748;}
@compute @workgroup_size(8,8) fn cs(@builtin(global_invocation_id) g:vec3u){
 let W=u32(u.stride);let H=u32(u.dst.y);if(g.x*4u>=W||g.y*2u>=H){return;}
 var c:array<vec3f,8>;
 for(var j=0u;j<2u;j++){var w=0u;for(var i=0u;i<4u;i++){let p=px(vec2u(g.x*4u+i,g.y*2u+j));c[j*4u+i]=p;w|=q8(16.0+219.0*dot(p,kw()))<<(8u*i);}ob[((g.y*2u+j)*W)/4u+g.x]=w;}
 var uv=0u;for(var k=0u;k<2u;k++){let a=(c[2u*k]+c[2u*k+1u]+c[4u+2u*k]+c[5u+2u*k])*0.25;let yy=dot(a,kw());
  uv|=(q8(128.0+224.0*(a.b-yy)/kb())<<(16u*k))|(q8(128.0+224.0*(a.r-yy)/kr())<<(16u*k+8u));}
 ob[(W*H)/4u+g.y*(W/4u)+g.x]=uv;}`;
// ripiego (browser senza importExternalTexture da VideoFrame, es. Chromium headless): texture rgba copiata (colori convertiti dal browser)
const WGSL_COPY = WGSL.replace('var t:texture_external;', 'var t:texture_2d<f32>;').replace('textureLoad(t,p)', 'textureLoad(t,p,0)').replace('textureSampleBaseClampToEdge(t,sp,uv)', 'textureSampleLevel(t,sp,uv,0.0)');
export const _wgsl = { WGSL, WGSL_COPY };

// ---------- WebGPU ----------
let G = null, EXT = true, COPY = 'frame';
const errStr = (e) => `${e?.name || 'Error'}: ${e?.message || e}`;
async function gpu() {
  if (G?.lost) G = null;
  if (G) return G;
  if (!navigator.gpu) throw new Error('WebGPU non disponibile (navigator.gpu assente)');
  const ad = await navigator.gpu.requestAdapter(); if (!ad) throw new Error('WebGPU: nessun adapter');
  const dev = await ad.requestDevice(), pipes = {};
  const g = { dev, smp: dev.createSampler({ minFilter: 'linear', magFilter: 'linear' }), pipe: (copy) => pipes[+copy] || (pipes[+copy] = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: copy ? WGSL_COPY : WGSL }), entryPoint: 'cs' } })) };
  dev.lost.then(() => { g.lost = true; });
  G = g; return g;
}
/** Risorsa di ingresso per il frame: texture esterna (Safari: dati HLG grezzi) o, in ripiego, texture rgba copiata. tmp: da distruggere. */
function srcEntry(g, f, tmp, note) {
  if (EXT) {
    try { return { copy: false, res: g.dev.importExternalTexture({ source: f }) }; }
    catch (e) { EXT = false; note(`importExternalTexture non riuscito (${errStr(e)}): copia in texture rgba (colori convertiti dal browser, solo prova)`); }
  }
  const w = f.displayWidth, h = f.displayHeight;
  if (COPY === 'frame') {
    const t = g.dev.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT }); tmp.push(t);
    try { g.dev.queue.copyExternalImageToTexture({ source: f }, { texture: t }, [w, h]); return { copy: true, res: t.createView() }; }
    catch (e) { COPY = 'canvas'; note(`copia dal VideoFrame non riuscita (${errStr(e)}): passo da canvas 2D (lento, solo prova)`); }
  }
  if (!g.cv || g.cv.width !== w || g.cv.height !== h) { g.cv = new OffscreenCanvas(w, h); g.cx = g.cv.getContext('2d'); }
  g.cx.drawImage(f, 0, 0, w, h); const px = g.cx.getImageData(0, 0, w, h).data;
  const t8 = g.dev.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); tmp.push(t8);
  g.dev.queue.writeTexture({ texture: t8 }, px, { bytesPerRow: w * 4 }, [w, h]);
  return { copy: true, res: t8.createView() };
}
/**
 * Convertitore frame del decoder → VideoFrame NV12 BT.709 (dw×dh). Compute → buffer di storage → copia in uno di `depth` buffer
 * MAP_READ → mapAsync (asincrono, `depth` frame in volo) → new VideoFrame(NV12). Evita VideoFrame(canvas WebGPU) (sdr8 v1: 102 fps).
 */
// hlg: tone mapping Hable → BT.709 (modalità 'sdr'); keep2020 (modalità 'hdr8'): nessuna conversione, i valori HLG sono solo scalati e
// riscritti in Y'CbCr con la matrice BT.2020 (la stessa con cui la texture esterna li ha letti), uscita colorSpace HLG.
export const CSHLG = { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: false };
export const VUIHLG = { primaries: 9, transfer: 18, matrix: 9, fullRange: false };
export async function createNv12Converter({ sw, sh, dw, dh, hlg, keep2020 = false, depth = SDR.inFlight, note = () => {} }) {
  if (dw % 2 || dh % 2) throw new Error(`SDR: uscita ${dw}×${dh} con lato dispari`);
  if (dw > sw || dh > sh) throw new Error(`SDR: ${sw}×${sh} → ${dw}×${dh} ingrandirebbe`);
  const g = await gpu(), S = nv12Stride(dw), size = S * dh * 3 / 2, taps = scaleTaps(sw, sh, dw, dh);
  const ub = g.dev.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  g.dev.queue.writeBuffer(ub, 0, new Float32Array([sw, sh, dw, dh, hlg && !keep2020 ? 2 : 0, SDR.hlgPeakNits, taps, S, keep2020 ? 1 : 0, 0, 0, 0]));
  const outCs = keep2020 ? CSHLG : CS709;
  const sb = g.dev.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }); // unico: la coda GPU è seriale
  const slots = Array.from({ length: depth }, () => ({ mb: g.dev.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: Promise.resolve() }));
  let n = 0;
  return {
    depth, taps,
    /** Converte f (lo chiude a GPU finita) → Promise<VideoFrame> con timestamp/durata di `fr` ({ts, dur} µs). */
    async submit(f, fr, T) {
      const s = slots[n++ % depth]; await s.busy;
      const tmp = []; let p;
      try {
        const src = srcEntry(g, f, tmp, note), pipe = g.pipe(src.copy);
        const bg = g.dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: src.res }, { binding: 1, resource: { buffer: ub } }, { binding: 2, resource: { buffer: sb } }, { binding: 3, resource: g.smp }] });
        const ce = g.dev.createCommandEncoder(), pass = ce.beginComputePass();
        pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(Math.ceil(S / 32), Math.ceil(dh / 16)); pass.end();
        ce.copyBufferToBuffer(sb, 0, s.mb, 0, size); g.dev.queue.submit([ce.finish()]);
        const tg = performance.now();
        p = s.mb.mapAsync(GPUMapMode.READ).then(() => {
          if (T) { T.gpu += performance.now() - tg; T.gpuN++; }
          try { return new VideoFrame(new Uint8Array(s.mb.getMappedRange()), { format: 'NV12', codedWidth: dw, codedHeight: dh, layout: [{ offset: 0, stride: S }, { offset: S * dh, stride: S }], ...frameTiming(fr), colorSpace: outCs }); }
          finally { s.mb.unmap(); }
        });
      } catch (e) { p = Promise.reject(e); }
      p = p.finally(() => { for (const t of tmp) t.destroy(); try { f.close(); } catch {} }); // il frame del decoder vive finché la GPU lo legge
      s.busy = p.then(() => {}, () => {});
      return p;
    },
    close() { try { ub.destroy(); sb.destroy(); for (const s of slots) s.mb.destroy(); } catch {} },
  };
}

/** 'hdr8' senza scalatura: il frame del decoder (NV12 8 bit, HLG grezzo) va diretto all'encoder, solo con il pts sorgente. */
export function createDirectConverter(depth = SDR.inFlight) {
  return { depth, taps: 0, submit(f, fr) { try { return Promise.resolve(new VideoFrame(f, frameTiming(fr))); } catch (e) { return Promise.reject(e); } finally { try { f.close(); } catch {} } }, close() {} };
}

// ---------- decoder con riordino ----------
/** Campanello: sveglia chi aspetta (uscite del decoder, dequeue, abort); `ms` = ripiego a tempo. */
function bell() { let ws = []; return { ring() { const w = ws; ws = []; for (const f of w) f(); }, wait(ms = 4) { return new Promise((r) => { ws.push(r); setTimeout(r, ms); }); } }; }
/**
 * Decodifica `chunks` (async iterable di EncodedVideoChunk in ordine di decodifica, dal keyframe che precede il primo frame richiesto)
 * e consegna con next() i frame di `wantUs` (µs, crescenti) nell'ordine dei pts. Frame fuori intervallo chiusi subito.
 * Decoder: costruttore (iniettabile nei test). Alimenta al massimo `ahead` chunk avanti e trattiene al massimo ~`ahead` frame pronti.
 */
export function decodeOrdered({ chunks, config, wantUs, signal = null, stats = null, Decoder = globalThis.VideoDecoder, ahead = SDR.decodeAhead }) {
  const B = bell(), ro = createReorder(wantUs), T = stats || {}; let err = null, fed = false, got = 0, prev = -Infinity;
  T.ooo ??= 0; T.extra ??= 0; T.decoded ??= 0;
  const dec = new Decoder({
    output: (f) => {
      T.decoded++; if (f.timestamp < prev) T.ooo++; prev = f.timestamp;
      if (ro.put(f.timestamp, f)) got++; else { T.extra++; f.close(); }
      B.ring();
    },
    error: (e) => { err ||= e; B.ring(); },
  });
  dec.ondequeue = () => B.ring();
  const onAbort = () => B.ring(); signal?.addEventListener?.('abort', onAbort);
  dec.configure(config);
  const live = () => !err && !signal?.aborted && dec.state === 'configured';
  (async () => {
    for await (const c of chunks) {
      while (live() && got < wantUs.length && (dec.decodeQueueSize >= ahead || (ro.size >= ahead && ro.ready()))) await B.wait();
      if (!live() || got >= wantUs.length) break;
      dec.decode(c);
    }
    if (live() && got < wantUs.length) await dec.flush();
  })().catch((e) => { if (dec.state !== 'closed') err ||= e; }).finally(() => { fed = true; B.ring(); });
  return {
    async next() {
      for (;;) {
        if (signal?.aborted) throw interruptError();
        if (ro.done) return null;
        const f = ro.take(); if (f) { B.ring(); return f; }
        if (err) throw err;
        if (fed) { T.missing = wantUs.length - ro.next; throw Object.assign(new Error(`SDR: il decoder non ha restituito ${wantUs.length - ro.next} frame (dal frame ${ro.next})`), { name: 'SdrMissingFrames' }); }
        await B.wait(20);
      }
    },
    close() { signal?.removeEventListener?.('abort', onAbort); for (const f of ro.drain()) { try { f.close(); } catch {} } try { if (dec.state !== 'closed') dec.close(); } catch {} },
  };
}
/** Pipeline: frame ordinati dal decoder → convertitore (`conv.depth` in volo) → VideoFrame in ordine. Async generator. */
export async function* convertOrdered(dec, conv, frames, stats = null, signal = null) {
  const pend = []; let i = 0;
  try {
    for (let out = 0; out < frames.length; out++) {
      while (pend.length < conv.depth && i < frames.length) {
        const f = await dec.next(); if (!f) break;
        const p = conv.submit(f, frames[i], stats); p.catch(() => {}); pend.push(p); i++;
      }
      if (!pend.length) break;
      const vf = await pend.shift();
      if (signal?.aborted) { vf.close(); throw interruptError(); }
      if (stats) stats.n = (stats.n || 0) + 1;
      yield vf;
    }
  } finally {
    for (const p of pend) p.then((v) => v.close(), () => {});
    dec.close();
  }
}

// ---------- sorgente per l'app ----------
/**
 * Apre la sorgente SDR sul track Mediabunny `track` (MB = modulo Mediabunny): decoder config, colore, dimensioni dal primo frame,
 * percorso GPU provato. Ritorna {width, height, hlg, transfer, gpuPath, frames(list, stats, signal, {width, height}) → async gen, close}.
 */
// tonemap: true = modalità 'sdr' (Hable → BT.709); false = 'hdr8' (HLG così com'è; GPU solo se si scala).
export async function openSdrSource({ MB, track, log = () => {}, tonemap = true }) {
  const config = await track.getDecoderConfig(); if (!config) throw new Error('SDR: codec non decodificabile (decoder config assente)');
  let transfer = null; try { transfer = (await track.getColorSpace())?.transfer || null; } catch {}
  const hlg = transfer === 'hlg';
  if (transfer === 'pq') log('SDR: sorgente PQ, tone mapping non previsto (solo HLG): colori non convertiti', 'warn');
  const sink = new MB.EncodedPacketSink(track);
  const notes = [], note = (t) => { notes.push(t); log('GPU: ' + t, 'warn'); };
  // dal keyframe che precede startS (decodifica in avanti), chunk in ordine di decodifica
  async function* chunksFrom(startS) {
    const key = await sink.getKeyPacket(startS, { verifyKeyPackets: true }) || await sink.getFirstPacket();
    if (!key) return;
    for await (const p of sink.packets(key)) yield p.toEncodedVideoChunk();
  }
  // primo frame: dimensioni reali (orientamento codificato: la rotazione va nella traccia)
  const first = await sink.getFirstPacket(); if (!first) throw new Error('SDR: nessun pacchetto video');
  async function firstFrame(use) {
    const d = decodeOrdered({ chunks: chunksFrom(first.timestamp + 1e-6), config, wantUs: [first.microsecondTimestamp ?? Math.round(first.timestamp * 1e6)] });
    let f = null;
    try { f = await d.next(); } catch (e) { d.close(); throw Object.assign(new Error(`VideoDecoder non riuscito (${errStr(e)})`), { name: e?.name || 'Error' }); }
    try { return await use(f); } finally { f?.close(); d.close(); }
  }
  let width = 0, height = 0, gpuPath = 'nessuno (frame diretti)', format = '';
  await firstFrame((f) => { width = f.displayWidth; height = f.displayHeight; format = f.format; });
  log(`decoder ${config.codec} → frame ${format} ${width}×${height}, colore ${transfer || '?'} → ${tonemap ? (hlg ? 'Hable (inversa HLG → BT.709)' : 'nessun tone mapping') : 'HLG invariato (nessuna conversione)'}`);
  /** Prova il percorso GPU sul primo frame (un import fallito può invalidare il device: se ne crea uno nuovo). */
  async function probeGpu() {
    await firstFrame(async (f) => {
      const g = await gpu(), tmp = []; try { srcEntry(g, f, tmp, note); } finally { for (const t of tmp) t.destroy(); }
      if (!EXT) { G = null; await gpu(); }
      gpuPath = EXT ? 'importExternalTexture' : COPY === 'frame' ? 'copyExternalImageToTexture' : 'canvas 2D';
    });
    log(`GPU: ${gpuPath}`);
  }
  return {
    width, height, hlg, transfer, config, notes, get gpuPath() { return gpuPath; },
    /** VideoFrame NV12 BT.709 per `list` ([{ts, dur}] µs, ordine di presentazione), uscita out.width×out.height. */
    async *frames(list, stats = null, signal = null, out = {}) {
      if (!list.length) return;
      const T = stats || {}; T.gpu ??= 0; T.gpuN ??= 0;
      const dw = out.width || width, dh = out.height || height, direct = !tonemap && dw === width && dh === height;
      if (!direct && gpuPath.startsWith('nessuno')) await probeGpu();
      const conv = direct ? createDirectConverter() : await createNv12Converter({ sw: width, sh: height, dw, dh, hlg, keep2020: !tonemap, note });
      let dec;
      try {
        dec = decodeOrdered({ chunks: chunksFrom(list[0].ts / 1e6 + 1e-6), config, wantUs: list.map((f) => f.ts), signal, stats: T });
        yield* convertOrdered(dec, conv, list, T, signal);
      } finally { dec?.close(); conv.close(); }
    },
    close() {},
  };
}
