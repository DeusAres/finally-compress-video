#!/usr/bin/env node
// Sonda layout di «Spazio occupato» (v0.37.1) in Chromium/Playwright: 320 e 390 px, chiaro/scuro, tendina e «Dettagli» aperti con
// file orfani finti in OPFS; nessun overflow orizzontale, nessun errore JS; «Libera spazio» toglie gli orfani e lascia il resto.
// Uso: node tools/lab/storage_probe.mjs [--shots <dir>]
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { arg, startServer, playwright } from './probe_kit.mjs';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), shots = arg('--shots', null);
if (shots) mkdirSync(shots, { recursive: true });
const srv = await startServer(REPO), browser = await playwright().chromium.launch();
let bad = 0; const fail = (m) => { bad++; console.log('FALLITO:', m); };
for (const [w, scheme] of [[320, 'light'], [320, 'dark'], [390, 'light'], [390, 'dark']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, colorScheme: scheme }), page = await ctx.newPage(), errs = [];
  page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(srv.base); await page.waitForSelector('[data-ref="stBox"]');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const [n, k] of [['orfano_con_un_nome_molto_lungo_1234567890_abcdefghijklmnopqrstuvwxyz.mov', 3e6], ['tmp.bin', 1e5]]) { const h = await root.getFileHandle(n, { create: true }); const wr = await h.createWritable(); await wr.write(new Uint8Array(k)); await wr.close(); }
    const j = await (await root.getDirectoryHandle('jobs', { create: true })).getDirectoryHandle('current', { create: true });
    const f = await j.getFileHandle('seg-0000.bin', { create: true }); const wr = await f.createWritable(); await wr.write(new Uint8Array(2e6)); await wr.close();
    localStorage.setItem('fcv.sceneLive', '1');
  });
  await page.click('[data-ref="stBox"] > summary'); await page.waitForFunction(() => /Spazio usato/.test(document.querySelector('[data-ref="stLine"]').textContent));
  await page.click('[data-ref="stDet"] > summary'); await page.waitForTimeout(400);
  const line = await page.textContent('[data-ref="stLine"]'), rows = await page.$$eval('.fcv-st-row', (r) => r.length);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (ov > 0) fail(`overflow orizzontale ${ov}px a ${w} ${scheme}`);
  if (!rows) fail('nessuna riga nei dettagli');
  if (shots) { await page.locator('[data-ref="stBox"]').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `storage-${w}-${scheme}.png`), fullPage: true }); }
  if (w === 320 && scheme === 'light') {
    const before = await page.$$eval('.fcv-st-row', (r) => r.length);
    await page.click('[data-ref="stFree"]'); await page.waitForTimeout(800);
    const names = await page.evaluate(async () => { const out = []; for await (const [n] of (await navigator.storage.getDirectory()).entries()) out.push(n); return out; });
    if (names.some((n) => n.startsWith('orfano') || n === 'tmp.bin')) fail('«Libera spazio» non ha tolto gli orfani: ' + names);
    if (!names.includes('jobs')) fail('«Libera spazio» ha tolto l\'export riprendibile');
    console.log(`riga: ${line} · voci prima ${before} dopo ${await page.$$eval('.fcv-st-row', (r) => r.length)} · OPFS ora: ${names}`);
  }
  if (errs.length) fail(`errori JS a ${w} ${scheme}: ${errs.join(' | ')}`);
  console.log(`${w}px ${scheme}: overflow ${ov}px, ${rows} righe`);
  await ctx.close();
}
await browser.close(); srv.close();
console.log(bad ? `${bad} FALLITI` : 'OK'); process.exit(bad ? 1 : 0);
