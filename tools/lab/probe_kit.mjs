// Attrezzi comuni delle sonde Playwright (lifecycle_probe.mjs, queue_probe.mjs): campioni H.264 per Chromium, server statico,
// strumentazione in pagina (Blob URL, VideoFrame, encoder/decoder, Worker, AudioContext, <video>/<audio>, File, OPFS) e snapshot
// con GC forzato via CDP.
//
// Chromium non decodifica né codifica HEVC: si usano COPIE H.264 del campione (ffmpeg, in $TMPDIR) e, SOLO in pagina di prova,
// i codec hvc1 → avc1 sono mappati su VideoEncoder/VideoDecoder (il file in uscita non è un HEVC valido: qui conta il ciclo di
// vita, non l'uscita). Il campione HEVC così com'è serve come percorso d'errore (il <video> di Chromium non lo decodifica).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const req = createRequire(import.meta.url);
export function playwright() { try { return req('playwright'); } catch { return req(join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright')); } }
export const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

/** n copie H.264 320 px del campione, con nome e peso diversi (metadato title diverso). */
export function makeSamples(src, n = 2, prefix = 'clip') {
  const tmp = mkdtempSync(join(tmpdir(), 'fcv-probe-')), out = [];
  const first = join(tmp, `${prefix}1_avc.mov`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=320:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-g', '30', '-preset', 'veryfast', '-c:a', 'copy', first]);
  out.push(first);
  for (let i = 2; i <= n; i++) { const p = join(tmp, `${prefix}${i}_avc.mov`); execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', first, '-c', 'copy', '-metadata', `title=${'b'.repeat(i)}`, p]); out.push(p); }
  return out;
}

/** Server statico su 127.0.0.1 (niente service worker: index.html lo registra solo su https/localhost). */
export async function startServer(root) {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
  const server = createServer(async (q, r) => {
    try { const p = join(root, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!p.startsWith(root) || !(await stat(p)).isFile()) throw 0;
      r.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); r.end(await readFile(p)); }
    catch { r.writeHead(404); r.end(); }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}/index.html`, close: () => server.close() };
}

// ---- strumentazione in pagina (prima di ogni script) ----
export const INIT = () => {
  const P = window.__probe = { urls: new Set(), frames: new Set(), codecs: new Set(), workers: new Set(), actx: new Set(), media: [], files: [], outs: [], made: { urls: 0, frames: 0, enc: 0, dec: 0, workers: 0 } };
  const cu = URL.createObjectURL, ru = URL.revokeObjectURL;
  URL.createObjectURL = function (o) { const u = cu.call(this, o); P.urls.add(u); P.made.urls++; return u; };
  URL.revokeObjectURL = function (u) { P.urls.delete(u); return ru.call(this, u); };
  const VF = window.VideoFrame, close = VF.prototype.close;
  const track = (f) => { P.frames.add(f); P.made.frames++; return f; };
  VF.prototype.close = function () { P.frames.delete(this); return close.call(this); };
  window.VideoFrame = new Proxy(VF, { construct(t, a, nt) { return track(Reflect.construct(t, a, nt)); } });
  // SOLO prova: Chromium non ha HEVC. Bitrate ×20 all'encoder: OpenH264 altrimenti salta fotogrammi (pacchetti < fotogrammi)
  const mapCodec = (c, enc) => (c && /^hvc1|^hev1/.test(c.codec) ? { ...c, codec: 'avc1.640028', ...(enc && c.bitrate ? { bitrate: c.bitrate * 20 } : {}) } : c);
  const wrapCodec = (Base, kind) => new Proxy(Base, { construct(t, [init], nt) {
    let mapped = false; // v0.36.2: solo gli encoder configurati in HEVC (mappati) dichiarano hvc1 in uscita; un vero H.264 (clip PiP) resta avc1
    const o = init?.output; const i2 = { ...init, output: kind === 'dec' ? (f, m) => o(track(f), m) : (ch, m) => { if (mapped && m?.decoderConfig && /^avc1/.test(m.decoderConfig.codec)) m = { ...m, decoderConfig: { ...m.decoderConfig, codec: 'hvc1.2.4.L123.B0' } }; o(ch, m); } };
    const x = Reflect.construct(t, [i2], nt); P.codecs.add(x); P.made[kind]++;
    const cf = x.configure.bind(x), cl = x.close.bind(x); x.configure = (c) => { mapped = !!(c && /^hvc1|^hev1/.test(c.codec)); return cf(mapCodec(c, kind === 'enc')); }; x.close = () => { P.codecs.delete(x); return cl(); };
    return x; } });
  window.VideoEncoder = wrapCodec(window.VideoEncoder, 'enc'); window.VideoDecoder = wrapCodec(window.VideoDecoder, 'dec');
  const W = window.Worker, term = W.prototype.terminate;
  W.prototype.terminate = function () { P.workers.delete(this); return term.call(this); };
  window.Worker = new Proxy(W, { construct(t, a, nt) { const w = Reflect.construct(t, a, nt); P.workers.add(w); P.made.workers++; return w; } });
  for (const k of ['AudioContext', 'webkitAudioContext']) { const A = window[k]; if (!A) continue; const c = A.prototype.close;
    A.prototype.close = function () { P.actx.delete(this); return c.call(this); };
    window[k] = new Proxy(A, { construct(t, a, nt) { const x = Reflect.construct(t, a, nt); P.actx.add(x); return x; } }); }
  // v0.36.2: <video>/<audio> anche FUORI dal DOM (createElement, new Audio, innerHTML/cloneNode via 'loadstart' in cattura).
  const seen = new WeakSet(), addMedia = (e) => { if (!e || seen.has(e)) return; seen.add(e); P.media.push(new WeakRef(e)); P.made[e.tagName === 'VIDEO' ? 'video' : 'audio'] = (P.made[e.tagName === 'VIDEO' ? 'video' : 'audio'] || 0) + 1; };
  const ce = Document.prototype.createElement;
  Document.prototype.createElement = function (n, o) { const e = ce.call(this, n, o); if (/^(video|audio)$/i.test(n)) addMedia(e); return e; };
  const A0 = window.Audio; window.Audio = new Proxy(A0, { construct(t, a, nt) { const e = Reflect.construct(t, a, nt); addMedia(e); return e; } });
  document.addEventListener('loadstart', (e) => { if (e.target instanceof HTMLMediaElement) addMedia(e.target); }, true);
  for (const k of ['AudioEncoder', 'AudioDecoder']) { const B = window[k]; if (!B) continue; // contati come i VideoEncoder/Decoder (aperti = state ≠ closed)
    window[k] = new Proxy(B, { construct(t, a, nt) { const x = Reflect.construct(t, a, nt); P.codecs.add(x); P.made[k] = (P.made[k] || 0) + 1; return x; } }); }
  document.addEventListener('change', (e) => { for (const f of e.target?.files || []) P.files.push(new WeakRef(f)); }, true);
  const F0 = window.File; window.File = new Proxy(F0, { construct(t, a, nt) { const f = Reflect.construct(t, a, nt); if (/\.(mov|mp4)$/.test(f.name)) P.outs.push(new WeakRef(f)); return f; } });
  const gf = FileSystemFileHandle.prototype.getFile;
  FileSystemFileHandle.prototype.getFile = async function () { const f = await gf.call(this); if (/\.(mov|mp4)$/.test(f.name)) P.outs.push(new WeakRef(f)); return f; };
  P.snap = async () => {
    const opfs = []; try { const walk = async (d, p) => { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, p + n + '/'); else opfs.push(p + n); } }; await walk(await navigator.storage.getDirectory(), ''); } catch {}
    const media = P.media.map((w) => w.deref()).filter(Boolean), hasSrc = (m) => !!(m.getAttribute('src') || m.srcObject || (m.currentSrc && m.networkState !== 0));
    return { heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(2), blobUrls: P.urls.size, frames: P.frames.size, codecs: [...P.codecs].filter((c) => c.state !== 'closed').length,
      workers: P.workers.size, audioCtx: [...P.actx].filter((a) => a.state !== 'closed').length, videoDom: document.querySelectorAll('video').length,
      mediaAlive: media.length, mediaSrc: media.filter((m) => m.getAttribute('src') || m.currentSrc).length,
      // con sorgente: attributo src, srcObject o currentSrc con networkState ≠ EMPTY (dopo removeAttribute('src') + load() currentSrc resta)
      vidSrc: media.filter((m) => m.tagName === 'VIDEO' && hasSrc(m)).length,
      vidSrcOut: media.filter((m) => m.tagName === 'VIDEO' && !m.isConnected && hasSrc(m)).length,
      vidPlay: media.filter((m) => m.tagName === 'VIDEO' && !m.paused && hasSrc(m)).length,
      mediaPlay: media.filter((m) => !m.paused && hasSrc(m)).length,
      vidMade: P.made.video || 0,
      filesAlive: P.files.filter((w) => w.deref()).length, outsAlive: P.outs.filter((w) => w.deref()).length, opfs: opfs.length, opfsList: opfs.join(' '),
      mediaInfo: media.map((m) => `${m.tagName}:${m.isConnected ? 'dom' : '-'}:${(m.getAttribute('src') || '').slice(0, 30)}:${(m.currentSrc || '').slice(0, 30)}:rs${m.readyState}:ns${m.networkState}`).join(' ') };
  };
};

/** Browser + pagina strumentata. extraInit: altro script di prova o elenco di script (es. mock di navigator.share). */
export async function openProbe(base, { extraInit, viewport } = {}) {
  const pw = playwright();
  const browser = await pw.chromium.launch({ args: ['--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext(viewport ? { viewport } : {}); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message + (process.env.STACK ? '\n' + e.stack : '')));
  await page.addInitScript(INIT); for (const x of [extraInit].flat()) if (x) await page.addInitScript(x);
  const cdp = await ctx.newCDPSession(page);
  await page.goto(base); await page.waitForSelector('[data-ref="go"]');
  const snap = async () => { for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(150); await cdp.send('HeapProfiler.collectGarbage'); return page.evaluate(() => window.__probe.snap()); };
  const logTail = (n = 4) => page.evaluate((n) => [...document.querySelectorAll('[data-ref="log"] div')].slice(-n).map((d) => d.textContent).join(' | '), n);
  return { browser, ctx, page, cdp, errors, snap, logTail };
}
export const SNAP_COLS = ['heapMB', 'blobUrls', 'frames', 'codecs', 'workers', 'audioCtx', 'videoDom', 'mediaAlive', 'mediaSrc', 'vidSrc', 'vidSrcOut', 'vidPlay', 'mediaPlay', 'vidMade', 'filesAlive', 'outsAlive', 'opfs'];
