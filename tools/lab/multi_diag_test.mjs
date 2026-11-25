// Prova tools/diag/multi.html in Chromium (Playwright): scala completa senza errori JS, poi «kill» simulato (reload a metà
// scalino) → la pagina deve mostrare il punto di crash, e «Riprendi» deve ripartire dallo scalino successivo.
// Chromium non codifica HEVC: la pagina ripiega su H.264/VP8 (solo verifica della logica).
// Uso: npx http-server -p 8765 -s . &  NODE_PATH=$(npm root -g) node tools/lab/multi_diag_test.mjs <video.webm> [http://localhost:8765]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const video = process.argv[2], base = process.argv[3] || 'http://localhost:8765';
if (!video) { console.error('manca il video di prova'); process.exit(2); }
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage(); const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
const fail = (m) => { console.log('FALLITO:', m, errors); process.exit(1); };
await page.goto(`${base}/tools/diag/multi.html`); await page.waitForFunction(() => window.__multi?.ready);
await page.click('#clear');
await page.setInputFiles('#file', video);
await page.selectOption('#nf', '60'); await page.selectOption('#nmax', '4');
await page.click('#go');
await page.waitForFunction(() => /finito|errore|fermato/.test(document.getElementById('state').textContent), null, { timeout: 300000 });
const st1 = await page.textContent('#state');
const r1 = await page.evaluate(() => window.__multi.results());
console.log('stato:', st1);
for (const s of r1.steps) console.log(`  ${s.test} N=${s.N}: ${s.totalFps} fps tot (${s.fpsMin}–${s.fpsMax}), bit ${s.bits.join('/') || '-'}, kbps ${s.kbps}, errori ${s.errors.length} ${s.errors.map((e) => e.name + ' ' + e.msg).join(';')}`);
console.log('  note:', r1.log.filter((e) => e.ev === 'note' || e.ev === 'stop').map((e) => e.msg || e.why).join(' | '));
const tests = new Set(r1.steps.map((s) => s.test));
if (!/finito/.test(st1) || !['pipe', 'enc', 'vid'].every((t) => tests.has(t))) fail('scala incompleta');
if (r1.crashes.length) fail('crash inatteso');

// kill simulato: reload appena parte uno scalino con N=2
await page.click('#go');
await page.waitForFunction(() => window.__multi.log.filter((e) => e.ev === 'run-start').length === 2);
await page.waitForFunction(() => window.__multi.log.some((e) => e.ev === 'step-start' && e.N === 2 && e.run === window.__multi.log.filter((x) => x.ev === 'run-start').pop().run), null, { timeout: 120000 });
await page.waitForTimeout(400);
await page.reload(); await page.waitForFunction(() => window.__multi?.ready);
const vis = await page.isVisible('#crashCard'), txt = await page.textContent('#crash');
const cr = await page.evaluate(() => window.__multi.analyze().filter((c) => c.last).map((c) => ({ test: c.step.test, N: c.step.N })));
console.log('dopo reload:', vis, txt.slice(0, 200), cr);
if (!vis || !cr.length || cr[0].N !== 2) fail('crash non rilevato');
await page.setInputFiles('#file', video);
await page.click('#resume');
await page.waitForFunction(() => window.__multi.log.filter((e) => e.ev === 'run-start').pop()?.resume && window.__multi.log.some((e) => e.ev === 'run-end' && e.run === window.__multi.log.filter((x) => x.ev === 'run-start').pop().run), null, { timeout: 300000 });
const r2 = await page.evaluate(() => { const L = window.__multi.log; const rs = L.filter((e) => e.ev === 'run-start').pop(); return { from: rs.from, first: L.find((e) => e.ev === 'step-start' && e.run === rs.run) }; });
console.log('ripresa da', r2.from, '→ primo scalino', r2.first?.test, r2.first?.N);
if (!(r2.first && r2.first.test === cr[0].test && r2.first.N === 3)) fail('ripresa non dallo scalino successivo');
await browser.close();
if (errors.length) fail('errori JS');
console.log('OK');
