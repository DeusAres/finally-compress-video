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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, makeSamples, startServer, openProbe } from './probe_kit.mjs';

// --root: cartella servita (es. un `git worktree` di una versione precedente, per le misure «prima»); il campione resta quello del repo
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), ROOT = resolve(arg('--root', REPO));
const N = +arg('--n', 4), SRC = resolve(REPO, arg('--sample', 'samples/IMG_7440.mov'));
const ONLY = arg('--only', 'nuovo,annulla,errore,impostazioni,ripresa').split(',');

// ---- campioni H.264 (Chromium) e server statico (strumentazione in pagina: probe_kit.mjs) ----
const [AVC, AVC2] = makeSamples(SRC, 2);
const server = await startServer(ROOT);
const { browser, page, errors, snap: snap0, logTail } = await openProbe(server.base);
const app = '#app';
const stage = () => page.$eval(app, (r) => r.dataset.stage);
const waitStage = (list, ms = 120000) => page.waitForFunction((l) => l.includes(document.querySelector('#app').dataset.stage) && document.querySelector('#app').dataset.busy === 'false', list, { timeout: ms })
  .catch(async (e) => { console.log('TIMEOUT, ultime righe del log:\n' + (await page.evaluate(() => [...document.querySelectorAll('[data-ref="log"] div')].slice(-25).map((d) => d.textContent).join('\n')))); throw e; });
const waitFile = () => page.waitForFunction(() => { const t = document.querySelector('[data-ref="fDur"]')?.textContent; return t && t !== '—'; }, null, { timeout: 30000 });
const pick = async (path) => {
  const ref = (await page.$eval('[data-ref="fileBox"]', (b) => b.hidden)) ? 'input' : (await stage()) === 'done' ? 'input3' : 'input2';
  await page.setInputFiles(`[data-ref="${ref}"]`, path); await waitFile();
  await page.waitForTimeout(300); // refreshResume / updateEstimate
};
const go = async () => { await page.click('[data-ref="go"]'); };
const snap = snap0;
const rows = [];
const rec = async (scen, i, extra = '') => { const s = await snap(); rows.push({ scen, i, ...s, extra }); };

await rec('avvio', 0);
const files = [AVC, AVC2];
if (ONLY.includes('nuovo')) for (let i = 1; i <= N; i++) { // scelta file → export completo → Nuovo video
  await pick(files[i % 2]); await go(); await waitStage(['done', 'error']);
  const st = await stage();
  if (st === 'done') { await page.click('[data-ref="save"]'); await page.waitForTimeout(300); } // «Salva»: in Chromium senza share sheet → download via Blob URL
  await rec('nuovo', i, st === 'done' ? 'export ok + salva' : 'ERRORE: ' + (await logTail()).slice(0, 200));
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
  await pick(SRC); await go(); await waitStage(['done', 'error'], 180000); if (process.env.LOG) console.log(await logTail(40)); await rec('errore', i, await stage());
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
if (process.env.MEDIA) for (const r of rows) console.log(r.scen, r.i, r.mediaInfo);
if (errors.length) console.log('errori pagina:', errors.slice(0, 5));
