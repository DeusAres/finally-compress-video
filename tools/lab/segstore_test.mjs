// Runs tools/lab/segstore-test.html in Chromium (Playwright) and checks the assembled MP4 with ffprobe.
// Usage: npx http-server -p 8765 -s . &  NODE_PATH=$(npm root -g) node tools/lab/segstore_test.mjs [http://localhost:8765]
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright'); // require: honours NODE_PATH (global install)
const base = process.argv[2] || 'http://localhost:8765';
const browser = await chromium.launch(); const page = await browser.newPage(); const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else console.log('  page:', m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
const url = `${base}/tools/lab/segstore-test.html`;
await page.goto(url); await page.waitForFunction(() => window.run1);
const r1 = await page.evaluate(() => window.run1());
console.log('run1 (kill a metà segmento 3):', r1);
await page.reload(); await page.waitForFunction(() => window.run2); // simulated reload: in-memory state lost
const r2 = await page.evaluate(() => window.run2());
console.log(await page.textContent('#out'));
await browser.close();
const dir = mkdtempSync(join(tmpdir(), 'segstore-')), f = join(dir, 'out.mp4');
writeFileSync(f, Buffer.from(r2.b64, 'base64'));
const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time,flags', '-of', 'json', f]).toString());
const pk = pr.packets, pts = pk.map((p) => +p.pts_time).sort((a, b) => a - b);
let maxGap = 0, minGap = 1; for (let i = 1; i < pts.length; i++) { const d = pts[i] - pts[i - 1]; maxGap = Math.max(maxGap, d); minGap = Math.min(minGap, d); }
const keys = pk.map((p, i) => (p.flags.includes('K') ? i : -1)).filter((i) => i >= 0);
execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']); // full decode: throws on errors
const ok = r1.done === 2 && pk.length === 900 && r2.nV === 900 && Math.abs(pts[0]) < 1e-6 && Math.abs(maxGap - 1 / 60) < 1e-3 && Math.abs(minGap - 1 / 60) < 1e-3 && [0, 240, 480, 720].every((k) => keys.includes(k)) && !r2.jobLeft && !errors.length;
console.log({ file: f, size: r2.size, packets: pk.length, firstPts: pts[0], lastPts: pts[pts.length - 1], minGap, maxGap, keyframes: keys, jobLeft: r2.jobLeft, errors });
console.log(ok ? 'OK' : 'FALLITO'); process.exit(ok ? 0 : 1);
