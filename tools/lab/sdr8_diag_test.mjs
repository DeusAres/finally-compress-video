// Prova tools/diag/sdr8.html in Chromium (Playwright): tutti i punti senza errori JS, MP4 prodotti e scaricabili.
// Chromium non codifica HEVC: la pagina ripiega su H.264 (avc1) e lo segnala nelle note (solo verifica della logica).
// Uso: npx http-server -p 8765 -s . &  NODE_PATH=$(npm root -g) node tools/lab/sdr8_diag_test.mjs <video.webm> [http://localhost:8765] [frame] [full]
// Default (v2): passi essenziali, al massimo 4 file (b_hable_8M.mp4, b_hable_mid.png, c_hlg8_8M.mp4, c_hlg8_mid.png).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const video = process.argv[2], base = process.argv[3] || 'http://localhost:8765', nf = process.argv[4] || '30', full = process.argv[5] === 'full';
if (!video) { console.error('manca il video di prova'); process.exit(2); }
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage(); const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/tools/diag/sdr8.html${full ? '?full' : ''}`); await page.waitForFunction(() => window.__sdr8?.ready);
await page.setInputFiles('#file', video);
await page.selectOption('#nf', nf);
await page.click('#go');
await page.waitForFunction(() => /finito|ERRORE/.test(document.getElementById('state').textContent), null, { timeout: 600000 });
const st = await page.textContent('#state');
const R = await page.evaluate(() => window.__sdr8.R), files = await page.evaluate(() => window.__sdr8.files());
console.log('stato:', st, '| note:', R.notes.join(' | '), '| gpu:', R.features.webgpu, R.features.gpuPath);
for (const [id, r] of Object.entries(R.runs)) console.log(`  ${id}: ${r.err ? 'ERR ' + r.err : r.skip ? 'skip ' + r.skip : 'ok'} fps ${r.fps ?? '-'} Mbps ${r.realMbps ?? '-'} ${r.ms ? JSON.stringify(r.ms) : ''} ${r.sameData ?? ''} ${r.file || ''} ${r.png || ''}`);
console.log('  file:', files.map((f) => `${f.name} ${(f.size / 1024).toFixed(0)}k`).join(', '));
await browser.close();
if (errors.length) { console.log('FALLITO: errori JS', errors); process.exit(1); }
if (!/finito/.test(st) || R.fatal) { console.log('FALLITO:', R.fatal); process.exit(1); }
const bad = Object.entries(R.runs).filter(([, r]) => r.err).map(([id, r]) => `${id}: ${r.err}`);
if (bad.length) { console.log('FALLITO: corse con errore', bad); process.exit(1); }
const want = ['b_hable_8M.mp4', 'b_hable_mid.png', 'c_hlg8_8M.mp4', 'c_hlg8_mid.png'], names = files.map((f) => f.name);
if (want.some((n) => !names.includes(n)) || (!full && names.length > 4)) { console.log('FALLITO: file attesi', want, 'trovati', names); process.exit(1); }
console.log('OK');
