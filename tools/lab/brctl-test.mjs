// node tools/lab/brctl-test.mjs : simulated encoder real = configured × k(fps); controller must converge within 2 segments to ±4 %.
import { nextBitrate, realBitrate } from '../../app/lib/brctl.js';
import assert from 'node:assert/strict';
const target = 8e6;
for (const k of [1.02, 0.89, 0.66, 1.2]) {
  let conf = target; const hist = [];
  for (let seg = 1; seg <= 4; seg++) { const real = conf * k; hist.push(real / target); conf = nextBitrate(conf, real, target); }
  const err = (s) => Math.abs(hist[s] - 1);
  console.log(`k=${k}: real/target per segmento`, hist.map((h) => h.toFixed(3)).join(' '), `→ conf ${(conf / 1e6).toFixed(2)} Mbps`);
  assert.ok(err(2) <= 0.04, `k=${k}: segmento 3 (dopo 2 correzioni) fuori ±4 %`);
}
// each segment = two 120-frame windows → within 1 segment of corrections the second half is already close
{ let conf = target; for (let w = 0; w < 4; w++) conf = nextBitrate(conf, conf * 0.66, target); assert.ok(Math.abs(conf * 0.66 / target - 1) <= 0.04); }
assert.equal(nextBitrate(8e6, 1e6, 8e6), 8e6 * 1.5);                 // step clamp up
assert.equal(nextBitrate(8e6, 80e6, 8e6), 8e6 * 0.7);                // step clamp down
assert.equal(nextBitrate(19e6, 1e6, 8e6), 8e6 * 2.5);                // absolute cap
assert.equal(nextBitrate(4.2e6, 80e6, 8e6), 8e6 * 0.5);              // absolute floor
assert.equal(nextBitrate(8e6, 0, 8e6), 8e6);
assert.equal(realBitrate(1e6, 1), 8e6);
console.log('ok');
