// Prova tools/diag/sdr8.html in Chromium (Playwright): tutti i punti senza errori JS, MP4 prodotti e scaricabili.
// Chromium non codifica HEVC: la pagina ripiega su H.264 (avc1) e lo segnala nelle note (solo verifica della logica).
// Uso: npx http-server -p 8765 -s . &  NODE_PATH=$(npm root -g) node tools/lab/sdr8_diag_test.mjs <video.webm> [http://localhost:8765] [frame] [fast|full|cmp]
// fast (default): ?mode=fast, al massimo 4 file (b_hable_8M.mp4, b_hable_mid.png, c_hlg8_8M.mp4, c_hlg8_mid.png).
// cmp (v2.2): confronto tone map, esattamente 2 file (tm_compare.png, b_apple_8M.mp4) e 4 varianti misurate.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const video = process.argv[2], base = process.argv[3] || 'http://localhost:8765', nf = process.argv[4] || '30', mode = process.argv[5] || 'fast', full = mode === 'full', cmp = mode === 'cmp';
if (!video) { console.error('manca il video di prova'); process.exit(2); }
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage(); const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/tools/diag/sdr8.html${cmp ? '' : full ? '?full&mode=fast' : '?mode=fast'}`); await page.waitForFunction(() => window.__sdr8?.ready);
await page.setInputFiles('#file', video);
await page.selectOption('#nf', nf);
await page.click('#go');
await page.waitForFunction(() => /finito|ERRORE/.test(document.getElementById('state').textContent), null, { timeout: 600000 });
const st = await page.textContent('#state');
const R = await page.evaluate(() => window.__sdr8.R), files = await page.evaluate(() => window.__sdr8.files());
if (process.env.OUT) for (const f of files) { // env OUT=<cartella>: salva i file prodotti
  const b64 = await page.evaluate(async (n) => { const a = [...document.querySelectorAll('#files a')].find((x) => x.download === n); const u = new Uint8Array(await (await fetch(a.href)).arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); }, f.name);
  (await import('node:fs')).writeFileSync(`${process.env.OUT}/${f.name}`, Buffer.from(b64, 'base64'));
}
console.log('stato:', st, '| note:', R.notes.join(' | '), '| gpu:', R.features.webgpu, R.features.gpuPath);
for (const [id, r] of Object.entries(R.runs)) console.log(`  ${id}: ${r.err ? 'ERR ' + r.err : r.skip ? 'skip ' + r.skip : 'ok'} fps ${r.fps ?? '-'} Mbps ${r.realMbps ?? '-'} ${r.ms ? JSON.stringify(r.ms) : ''} ${r.sameData ?? ''} ${r.file || ''} ${r.png || ''}`);
console.log('  file:', files.map((f) => `${f.name} ${(f.size / 1024).toFixed(0)}k`).join(', '));
await browser.close();
if (errors.length) { console.log('FALLITO: errori JS', errors); process.exit(1); }
if (!/finito/.test(st) || R.fatal) { console.log('FALLITO:', R.fatal); process.exit(1); }
const names = files.map((f) => f.name);
const bad = Object.entries(R.runs).filter(([, r]) => r.err).map(([id, r]) => `${id}: ${r.err}`);
if (bad.length) { console.log('FALLITO: corse con errore', bad); process.exit(1); }
if (cmp) {
  const v = R.runs.tm_cmp?.variants || {}, ok = ['bt2446c', 'apple', 'bt2408', 'hable'].every((k) => v[k]?.Ymean >= 0);
  if (names.length !== 2 || !names.includes('tm_compare.png') || !names.includes('b_apple_8M.mp4') || !ok) { console.log('FALLITO: confronto', names, v); process.exit(1); }
  console.log('varianti:', JSON.stringify(v)); console.log('OK'); process.exit(0);
}
const want = ['b_hable_8M.mp4', 'b_hable_mid.png', 'c_hlg8_8M.mp4', 'c_hlg8_mid.png'];
if (want.some((n) => !names.includes(n)) || (!full && names.length > 4)) { console.log('FALLITO: file attesi', want, 'trovati', names); process.exit(1); }
console.log('OK');
