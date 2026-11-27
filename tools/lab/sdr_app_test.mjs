#!/usr/bin/env node
// Export completo dell'APP in modalità SDR / HDR8 (v0.38, app/lib/sdrpath.js) in Chromium (Playwright, WebGPU SwiftShader).
// Chromium non codifica HEVC: l'app ripiega su H.264 (riga «⚠️ … solo per prova» nel log) → si verifica la LOGICA (decoder,
// riordino, compute shader, scalatura, segmenti, mux), non il file HEVC. Campione: clip H.264 sintetica 1280×720 con B-frame.
// Uso: node tools/lab/sdr_app_test.mjs   (exit 0 = tutti gli scenari senza errori JS, stage «done», nome file atteso)
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright, startServer } from './probe_kit.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = mkdtempSync(join(tmpdir(), 'fcv-sdr-')), clip = join(tmp, 'clip_avc.mov');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=7', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2', '-g', '30', '-preset', 'veryfast', '-crf', '2', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-shortest', clip]);
const server = await startServer(REPO);
const browser = await playwright().chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] });
const SCEN = [{ mode: 'sdr', res: 'orig', tag: '_SDR_' }, { mode: 'sdr', res: 480, tag: '_SDR_480p_' }, { mode: 'hdr8', res: 'orig', tag: '_HDR8_' }, { mode: 'hdr8', res: 540, tag: '_HDR8_540p_' }];
let fail = 0;
for (const sc of SCEN) {
  const page = await (await browser.newContext()).newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(server.base); await page.waitForSelector('[data-ref="go"]');
  await page.setInputFiles('[data-ref="input"]', clip);
  await page.waitForFunction(() => { const t = document.querySelector('[data-ref="fDur"]')?.textContent; return t && t !== '—'; }, null, { timeout: 30000 });
  await page.evaluate(({ mode, res }) => {
    const set = (sel, v) => { const e = document.querySelector(sel); if (!e) return false; e.checked = v; e.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    set('input[name="fcv-mode"]', mode !== 'sdr'); if (mode === 'hdr8') set('input[name="fcv-bits"]', false);
    if (res !== 'orig' && !set(`input[name="fcv-res"][value="${res}"]`, true)) { const g = document.querySelector('[data-ref="resGrid"]'); g.insertAdjacentHTML('beforeend', `<label><input type="radio" name="fcv-res" value="${res}" checked></label>`); }
  }, sc);
  await page.waitForTimeout(300); await page.click('[data-ref="go"]');
  const t0 = Date.now();
  await page.waitForFunction(() => ['done', 'error'].includes(document.querySelector('#app').dataset.stage) && document.querySelector('#app').dataset.busy === 'false', null, { timeout: 300000 }).catch(() => {});
  const stage = await page.$eval('#app', (r) => r.dataset.stage), log = await page.evaluate(() => [...document.querySelectorAll('[data-ref="log"] div')].map((d) => d.textContent).join('\n'));
  const file = (log.match(/file: (\S+)/) || [])[1] || '', pick = (re) => (log.match(re) || [])[0] || '';
  const ok = stage === 'done' && !errors.length && file.includes(sc.tag);
  console.log(`${ok ? 'OK ' : 'KO '} ${sc.mode} res ${sc.res}: stage ${stage}, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${file}`);
  for (const re of [/(SDR|HDR8): \d+ frame all'encoder[^\n]*/, /riduzione (SDR|HDR8): [^\n]*/, /encoder (SDR|HDR8): [^\n]*/, /segmento \d+: reale[^\n]*/, /COMPRESSIONE[^\n]*/]) { const l = pick(re); if (l) console.log('     ' + l.slice(0, 220)); }
  if (!ok) { fail++; console.log('     errori JS:', errors, '\n' + log.split('\n').slice(-25).join('\n')); }
  await page.context().close();
}
await browser.close(); server.close?.();
console.log(fail ? `FALLITI ${fail}/${SCEN.length}` : 'TUTTI OK'); process.exit(fail ? 1 : 0);
