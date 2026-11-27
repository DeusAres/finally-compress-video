// Test Node della logica pura delle miniature (v0.38.7). Uso: node app/lib/thumb.test.mjs
import assert from 'node:assert/strict';
const { thumbTime, thumbDims, drawRotated, makeThumb } = await import('./thumb.js');
assert.equal(thumbTime(100), 10); assert.ok(Math.abs(thumbTime(0.2) - 0.02) < 1e-9); assert.equal(thumbTime(NaN), 0); assert.equal(thumbTime(0), 0); assert.equal(thumbTime(undefined), 0);
let d = thumbDims(1920, 1080, 0); assert.deepEqual([d.cw, d.ch, d.quarter], [96, 54, 0]);
d = thumbDims(1920, 1080, 90); assert.deepEqual([d.cw, d.ch, d.quarter], [54, 96, 1]);
d = thumbDims(1080, 1920, 270); assert.deepEqual([d.cw, d.ch, d.quarter], [96, 54, 3]);
d = thumbDims(1920, 1080, 180); assert.deepEqual([d.cw, d.ch], [96, 54]);
d = thumbDims(1920, 1080, -90); assert.equal(d.quarter, 3);
d = thumbDims(40, 20, 0); assert.deepEqual([d.cw, d.ch, d.k], [40, 20, 1]); // mai ingrandito
const calls = []; const ctx = { save() {}, restore() {}, translate: (...a) => calls.push(['t', ...a]), rotate: (a) => calls.push(['r', a]), drawImage: (...a) => calls.push(['d', ...a]) };
drawRotated(ctx, 'S', 200, 100, { cw: 50, ch: 100, quarter: 1, k: 0.5 });
assert.deepEqual(calls[0], ['t', 25, 50]); assert.equal(calls[1][1], Math.PI / 2); assert.deepEqual(calls[2], ['d', 'S', -50, -25, 100, 50]);
assert.equal(await makeThumb({}), null); // senza VideoDecoder/document: ripiego, mai <video>
console.log('ok thumb');
