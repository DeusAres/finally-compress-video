// Test della stima del peso probabile (qualità per scena). Uso: node app/ui/estimate.test.mjs
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
const { estimateLikelyMB, learnBitrate, likelyVideoMbps, srcVideoBps, loadRatios, ratioKey, estimateOutBytes, BR_HIST_MAX } = await import('./estimate.js');
const f = { sizeMB: 14.4, durS: 13.4, aacBps: 128000, apacBps: 0 }; // ≈ 8.6 Mbps sorgente
const src = srcVideoBps(f), srcM = src / 1e6;
assert.ok(srcM > 8 && srcM < 9, `sorgente ${srcM}`);
const hdr = { mode: 'hdr', width: 1920, height: 1080 };
// senza storia: prior ≈ 0.4 × sorgente, limitato dal tetto
let e = estimateLikelyMB(hdr, f, 8);
assert.equal(e.learned, false);
assert.ok(Math.abs(e.mbps - 0.4 * srcM) < 0.01, `prior ${e.mbps}`);
assert.ok(e.mb < estimateOutBytes({ durS: 13.4, videoMbps: 8, aacBps: 128000 }) / 1048576);
assert.equal(likelyVideoMbps(hdr, src, 2).mbps, 2); // tetto più basso del prior
// con storia: mediana dei rapporti; riuscita reale 5.9 MB → rapporto appreso
const r1 = learnBitrate(hdr, { outMB: 5.9, ...f });
assert.ok(r1 > 0.3 && r1 < 0.5, `ratio ${r1}`);
e = estimateLikelyMB(hdr, f, 8);
assert.equal(e.learned, true);
assert.ok(Math.abs(e.mb - 5.9) < 0.1, `stimato ${e.mb}`); // riproduce il reale
learnBitrate(hdr, { outMB: 5.9, ...f }); learnBitrate(hdr, { outMB: 14, ...f }); // mediana robusta all'outlier
assert.equal(loadRatios(hdr).length, 3);
assert.ok(Math.abs(estimateLikelyMB(hdr, f, 8).mb - 5.9) < 0.1);
assert.ok(estimateLikelyMB(hdr, f, 3).mbps <= 3); // mai oltre il tetto
// per modo: SDR separato da HDR
assert.equal(loadRatios({ mode: 'sdr', width: 1920, height: 1080 }).length, 0);
learnBitrate({ mode: 'sdr', width: 1920, height: 1080 }, { outMB: 3.7, ...f });
const sdrE = estimateLikelyMB({ mode: 'sdr', width: 1920, height: 1080 }, f, 8);
assert.ok(Math.abs(sdrE.mb - 3.7) < 0.1 && sdrE.mb < estimateLikelyMB(hdr, f, 8).mb);
assert.notEqual(ratioKey(hdr), ratioKey({ ...hdr, width: 3840, height: 2160 }));
assert.notEqual(ratioKey({ mode: 'sdr', width: 3840, height: 2160 }), ratioKey({ mode: 'sdr', width: 3840, height: 2160, res: 1080 }));
// storia circolare e rapporti assurdi scartati
for (let i = 0; i < 20; i++) learnBitrate(hdr, { outMB: 6, ...f });
assert.equal(loadRatios(hdr).length, BR_HIST_MAX);
assert.equal(learnBitrate(hdr, { outMB: 0, ...f }), null);
console.log('estimate.test OK');
