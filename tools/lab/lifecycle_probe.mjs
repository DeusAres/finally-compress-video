#!/usr/bin/env node
// Sonda del ciclo di vita delle risorse (v0.35.4): ripete in Chromium (Playwright) «scegli video → export → Nuovo video»
// e gli altri percorsi (annulla, errore, altre impostazioni dopo l'export, ripresa da segmenti) e dopo ogni giro misura,
// con GC forzato (CDP): heap JS, Blob URL vivi, <video>/<audio> nel DOM o con src, VideoFrame non chiusi, VideoEncoder/
// VideoDecoder aperti, Worker non terminati, AudioContext aperti, File scelti/risultati ancora raggiungibili, voci OPFS.
// Una perdita si vede come contatore che cresce con i giri (atteso: costante, ~0 a riposo).
//
// Chromium non decodifica né codifica HEVC: la sonda usa una COPIA H.264 del campione (ffmpeg, in $TMPDIR) e, SOLO in pagina
// di prova, mappa i codec hvc1 → avc1 su VideoEncoder/VideoDecoder (il file in uscita non è un HEVC valido: qui conta la
// memoria, non l'uscita). Con --hevc usa il campione HEVC così com'è (percorso d'errore: il <video> non decodifica).
//
// Uso: node tools/lab/lifecycle_probe.mjs [--n 4] [--sample samples/IMG_7440.mov] [--only nuovo,annulla,errore,impostazioni,ripresa]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.url);
let pw; try { pw = req('playwright'); } catch { pw = req(join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright')); }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('--n', 4), SRC = resolve(ROOT, arg('--sample', 'samples/IMG_7440.mov'));
const ONLY = arg('--only', 'nuovo,annulla,errore,impostazioni,ripresa').split(',');

// ---- campione H.264 (Chromium) ----
const tmp = mkdtempSync(join(tmpdir(), 'fcv-life-'));
const AVC = join(tmp, 'clip_avc.mov'), AVC2 = join(tmp, 'clip2_avc.mov');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', SRC, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=640:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-preset', 'veryfast', '-c:a', 'copy', AVC]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', AVC, '-c', 'copy', '-metadata', 'title=b', AVC2]); // secondo file (altro nome/dimensione)

// ---- server statico (127.0.0.1: niente service worker, che index.html registra solo su https/localhost) ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer(async (q, r) => {
  try { const p = join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!p.startsWith(ROOT) || !(await stat(p)).isFile()) throw 0;
    r.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); r.end(await readFile(p)); }
  catch { r.writeHead(404); r.end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;

// ---- strumentazione in pagina (prima di ogni script) ----
const INIT = () => {
  const P = window.__probe = { urls: new Set(), frames: new Set(), codecs: new Set(), workers: new Set(), actx: new Set(), media: [], files: [], outs: [], made: { urls: 0, frames: 0, enc: 0, dec: 0, workers: 0 } };
  const cu = URL.createObjectURL, ru = URL.revokeObjectURL;
  URL.createObjectURL = function (o) { const u = cu.call(this, o); P.urls.add(u); P.made.urls++; return u; };
  URL.revokeObjectURL = function (u) { P.urls.delete(u); return ru.call(this, u); };
  const VF = window.VideoFrame, close = VF.prototype.close;
  const track = (f) => { P.frames.add(f); P.made.frames++; return f; };
  VF.prototype.close = function () { P.frames.delete(this); return close.call(this); };
  window.VideoFrame = new Proxy(VF, { construct(t, a, nt) { return track(Reflect.construct(t, a, nt)); } });
  const mapCodec = (c) => (c && /^hvc1|^hev1/.test(c.codec) ? { ...c, codec: 'avc1.640028' } : c); // SOLO prova: Chromium non ha HEVC
  const wrapCodec = (Base, kind) => new Proxy(Base, { construct(t, [init], nt) {
    const o = init?.output; const i2 = { ...init, output: kind === 'dec' ? (f, m) => o(track(f), m) : (ch, m) => { if (m?.decoderConfig && /^avc1/.test(m.decoderConfig.codec)) m = { ...m, decoderConfig: { ...m.decoderConfig, codec: 'hvc1.2.4.L123.B0' } }; o(ch, m); } };
    const x = Reflect.construct(t, [i2], nt); P.codecs.add(x); P.made[kind]++;
    const cf = x.configure.bind(x), cl = x.close.bind(x); x.configure = (c) => cf(mapCodec(c)); x.close = () => { P.codecs.delete(x); return cl(); };
    return x; } });
  window.VideoEncoder = wrapCodec(window.VideoEncoder, 'enc'); window.VideoDecoder = wrapCodec(window.VideoDecoder, 'dec');
  const W = window.Worker, term = W.prototype.terminate;
  W.prototype.terminate = function () { P.workers.delete(this); return term.call(this); };
  window.Worker = new Proxy(W, { construct(t, a, nt) { const w = Reflect.construct(t, a, nt); P.workers.add(w); P.made.workers++; return w; } });
  for (const k of ['AudioContext', 'webkitAudioContext']) { const A = window[k]; if (!A) continue; const c = A.prototype.close;
    A.prototype.close = function () { P.actx.delete(this); return c.call(this); };
    window[k] = new Proxy(A, { construct(t, a, nt) { const x = Reflect.construct(t, a, nt); P.actx.add(x); return x; } }); }
  const ce = Document.prototype.createElement;
  Document.prototype.createElement = function (n, o) { const e = ce.call(this, n, o); if (/^(video|audio)$/i.test(n)) P.media.push(new WeakRef(e)); return e; };
  const A0 = window.Audio; window.Audio = new Proxy(A0, { construct(t, a, nt) { const e = Reflect.construct(t, a, nt); P.media.push(new WeakRef(e)); return e; } });
  document.addEventListener('change', (e) => { const f = e.target?.files?.[0]; if (f) P.files.push(new WeakRef(f)); }, true);
  const gf = FileSystemFileHandle.prototype.getFile;
  FileSystemFileHandle.prototype.getFile = async function () { const f = await gf.call(this); if (/\.(mov|mp4)$/.test(f.name)) P.outs.push(new WeakRef(f)); return f; };
  P.snap = async () => {
    const opfs = []; try { const walk = async (d, p) => { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, p + n + '/'); else opfs.push(p + n); } }; await walk(await navigator.storage.getDirectory(), ''); } catch {}
    const media = P.media.map((w) => w.deref()).filter(Boolean);
    return { heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(2), blobUrls: P.urls.size, frames: P.frames.size, codecs: [...P.codecs].filter((c) => c.state !== 'closed').length,
      workers: P.workers.size, audioCtx: [...P.actx].filter((a) => a.state !== 'closed').length, videoDom: document.querySelectorAll('video').length,
      mediaAlive: media.length, mediaSrc: media.filter((m) => m.getAttribute('src') || m.currentSrc).length,
      filesAlive: P.files.filter((w) => w.deref()).length, outsAlive: P.outs.filter((w) => w.deref()).length, opfs: opfs.length, opfsList: opfs.join(' ') };
  };
};

const browser = await pw.chromium.launch({ args: ['--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext(); const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(INIT);
const cdp = await ctx.newCDPSession(page);
await page.goto(BASE); await page.waitForSelector('[data-ref="go"]');
const app = '#app';
const stage = () => page.$eval(app, (r) => r.dataset.stage);
const waitStage = (list, ms = 120000) => page.waitForFunction((l) => l.includes(document.querySelector('#app').dataset.stage) && document.querySelector('#app').dataset.busy === 'false', list, { timeout: ms });
const waitFile = () => page.waitForFunction(() => { const t = document.querySelector('[data-ref="fDur"]')?.textContent; return t && t !== '—'; }, null, { timeout: 30000 });
const pick = async (path) => {
  const ref = (await page.$eval('[data-ref="fileBox"]', (b) => b.hidden)) ? 'input' : (await stage()) === 'done' ? 'input3' : 'input2';
  await page.setInputFiles(`[data-ref="${ref}"]`, path); await waitFile();
  await page.waitForTimeout(300); // refreshResume / updateEstimate
};
const go = async () => { await page.click('[data-ref="go"]'); };
const snap = async () => { for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(150); await cdp.send('HeapProfiler.collectGarbage'); return page.evaluate(() => window.__probe.snap()); };
const rows = [];
const rec = async (scen, i, extra = '') => { const s = await snap(); rows.push({ scen, i, ...s, extra }); };
const logTail = () => page.evaluate(() => [...document.querySelectorAll('[data-ref="log"] div')].slice(-4).map((d) => d.textContent).join(' | '));

await rec('avvio', 0);
const files = [AVC, AVC2];
if (ONLY.includes('nuovo')) for (let i = 1; i <= N; i++) { // scelta file → export completo → Nuovo video
  await pick(files[i % 2]); await go(); await waitStage(['done', 'error']);
  const st = await stage(); await rec('nuovo', i, st === 'done' ? 'export ok' : 'ERRORE: ' + (await logTail()).slice(0, 200));
}
if (ONLY.includes('impostazioni')) for (let i = 1; i <= N; i++) { // dopo l'export: «Altre impostazioni» → bitrate diverso → Comprimi
  if ((await stage()) !== 'done') { await pick(files[0]); await go(); await waitStage(['done', 'error']); }
  await page.click('[data-ref="again"]'); await page.click(`input[name="fcv-br"][value="${[4, 6, 10, 8][i % 4]}"]`, { force: true }).catch(() => {});
  await go(); await waitStage(['done', 'error']); await rec('impostazioni', i, await stage());
}
if (ONLY.includes('annulla')) for (let i = 1; i <= N; i++) { // annulla durante la fase video
  await pick(files[i % 2]); await go();
  await page.waitForFunction(() => /Video|Prove|Analisi/i.test(document.querySelector('[data-ref="phName"]')?.textContent || '') && document.querySelector('#app').dataset.busy === 'true', null, { timeout: 30000 });
  await page.waitForTimeout(400 + 150 * i); await page.click('[data-ref="cancel"]'); await waitStage(['ready', 'pick', 'done', 'error']);
  await rec('annulla', i, await stage());
}
if (ONLY.includes('errore')) for (let i = 1; i <= N; i++) { // errore: campione HEVC (il <video> di Chromium non lo decodifica)
  await pick(SRC); await go(); await waitStage(['done', 'error'], 180000); await rec('errore', i, await stage());
}
if (ONLY.includes('ripresa')) for (let i = 1; i <= Math.min(N, 3); i++) { // ripresa da segmenti: ricarica a metà fase video, poi Riprendi
  await pick(files[0]); await page.evaluate(() => { document.querySelector('input[name="fcv-sceneq"]').checked = false; document.querySelector('input[name="fcv-sceneq"]').dispatchEvent(new Event('change', { bubbles: true })); });
  await go();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-ref="log"] div')].some((d) => /segmento 1\/\d+ salvato/.test(d.textContent)), null, { timeout: 60000 });
  await page.reload(); await page.waitForSelector('[data-ref="go"]'); await page.waitForTimeout(500);
  await pick(files[0]);
  const offer = await page.$eval('[data-ref="resume"]', (b) => !b.hidden);
  if (offer) { await page.click('[data-ref="resumeBtn"]'); await waitStage(['done', 'error']); }
  await rec('ripresa', i, `${offer ? 'offerta ripresa → ' + (await stage()) : 'NESSUNA offerta di ripresa'} · ${(await logTail()).match(/RIPRESA[^|]*/)?.[0] || ''}`.slice(0, 160));
}
// riposo finale: Nuovo video senza export (il risultato precedente deve essere rilasciato anche in OPFS)
await pick(files[1]); await rec('riposo', 0, 'solo scelta file');

await browser.close(); server.close();
const cols = ['scen', 'i', 'heapMB', 'blobUrls', 'frames', 'codecs', 'workers', 'audioCtx', 'videoDom', 'mediaAlive', 'mediaSrc', 'filesAlive', 'outsAlive', 'opfs', 'extra'];
console.log(cols.join('\t'));
for (const r of rows) console.log(cols.map((c) => r[c]).join('\t'));
console.log('OPFS finale:', rows.at(-1).opfsList || '(vuoto)');
if (errors.length) console.log('errori pagina:', errors.slice(0, 5));
