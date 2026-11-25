// Test Node del ciclo di vita dei VideoFrame in frames.js (v0.35.4): nessun frame resta aperto quando un player fallisce.
// Uso: node app/lib/frames.test.mjs
import assert from 'node:assert/strict';

const open = new Set();
globalThis.VideoFrame = class { constructor(src, o) { this.ts = o.timestamp; open.add(this); } close() { open.delete(this); } };
const { warmPlayers, parallelFrames, newStats } = await import('./frames.js');

/** <video> finto: il seek presenta il frame (rVFC con mediaTime = istante richiesto) e poi emette 'seeked'. fail: il seek lancia; slow: ms di ritardo. */
function fakeVideo({ fail = false, slow = 0 } = {}) {
  const ls = new Map(); let cbs = [];
  return {
    addEventListener(t, f) { (ls.get(t) || ls.set(t, new Set()).get(t)).add(f); },
    removeEventListener(t, f) { ls.get(t)?.delete(f); },
    requestVideoFrameCallback(f) { cbs.push(f); },
    set currentTime(t) {
      if (fail) throw new Error('seek rotto');
      setTimeout(() => { const c = cbs; cbs = []; c.forEach((f) => f(0, { mediaTime: t })); for (const f of [...(ls.get('seeked') || [])]) f(); }, slow);
    },
  };
}
const fr = (i) => ({ ts: i * 16667, dur: 16667 });

// 1) un player fallisce subito, l'altro consegna dopo: nessun keep, nessun frame aperto, errore propagato
{
  const kept = [];
  await assert.rejects(warmPlayers([fakeVideo({ slow: 30 }), fakeVideo({ fail: true })], (p) => fr(10 + p), null, { keep: (p, vf) => kept.push(vf) }), /seek rotto/);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(kept.length, 0, 'keep non chiamato se un player fallisce');
  assert.equal(open.size, 0, 'nessun VideoFrame aperto');
}
// 2) caso normale: keep riceve il frame del player 0, quello del player 1 è chiuso
{
  const kept = [];
  const r = await warmPlayers([fakeVideo(), fakeVideo({ slow: 5 })], (p) => fr(20 + p), null, { keep: (p, vf) => { if (p === 0) kept.push(vf); else vf.close(); } });
  assert.deepEqual(r.map((x) => x.ok), [true, true]);
  assert.equal(kept.length, 1); kept[0].close();
  assert.equal(open.size, 0);
}
// 3) parallelFrames interrotto a metà dal consumatore: i frame in buffer sono chiusi
{
  const list = Array.from({ length: 12 }, (_, i) => fr(i)), st = newStats();
  let n = 0;
  for await (const vf of parallelFrames([fakeVideo(), fakeVideo({ slow: 2 })], list, st, null, { maxFlight: 4 })) { vf.close(); if (++n === 5) break; }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(open.size, 0, 'buffer di parallelFrames chiuso al break');
}
console.log('frames.test: OK');
