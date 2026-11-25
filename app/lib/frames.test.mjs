// Test Node del ciclo di vita dei VideoFrame in frames.js (v0.35.4): nessun frame resta aperto quando un player fallisce.
// Uso: node app/lib/frames.test.mjs
import assert from 'node:assert/strict';

const open = new Set();
globalThis.VideoFrame = class { constructor(src, o) { this.ts = o.timestamp; open.add(this); } close() { open.delete(this); } };
const { warmPlayers, parallelFrames, seekFrames, newStats, _setSeekTimeout, isSeekTimeout } = await import('./frames.js');
_setSeekTimeout(40); // seek «bloccato» in 2×40 ms invece di 2×4 s

/** <video> finto: il seek presenta il frame (rVFC con mediaTime = istante richiesto) e poi emette 'seeked'. fail: il seek lancia; slow: ms di ritardo. */
function fakeVideo({ fail = false, slow = 0, hangAt = Infinity } = {}) { // hangAt: dal seek n. hangAt in poi nessun 'seeked' (player bloccato)
  let nSeek = 0;
  const ls = new Map(); let cbs = [];
  return {
    addEventListener(t, f) { (ls.get(t) || ls.set(t, new Set()).get(t)).add(f); },
    removeEventListener(t, f) { ls.get(t)?.delete(f); },
    requestVideoFrameCallback(f) { cbs.push(f); },
    set currentTime(t) {
      if (fail) throw new Error('seek rotto');
      if (++nSeek >= hangAt) return;
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
// 4) v0.36.2 seekFrames: player bloccato → ricreato (reopen) e stesso frame riprovato; tutti i frame consegnati in ordine
{
  const list = Array.from({ length: 8 }, (_, i) => fr(i)), st = newStats(), re = [];
  const got = [];
  for await (const vf of seekFrames(fakeVideo({ hangAt: 4 }), list, (st.players = [st], st), null, { reopen: async (p) => { re.push(p); return fakeVideo(); } })) { got.push(vf.ts); vf.close(); }
  assert.deepEqual(got, list.map((f) => f.ts), 'tutti i frame, in ordine');
  assert.deepEqual(re, [0], 'un solo reopen del player 1');
  assert.equal(open.size, 0);
}
// 5) seekFrames: bloccato anche dopo il reopen → errore SeekTimeout (guasto reale, non mascherato); senza reopen: errore subito
{
  const list = Array.from({ length: 6 }, (_, i) => fr(i)), st = newStats();
  await assert.rejects((async () => { for await (const vf of seekFrames(fakeVideo({ hangAt: 2 }), list, (st.players = [st], st), null, { reopen: async () => fakeVideo({ hangAt: 1 }) })) vf.close(); })(), (e) => isSeekTimeout(e));
  await assert.rejects((async () => { for await (const vf of seekFrames(fakeVideo({ hangAt: 2 }), list, null, null)) vf.close(); })(), /seek timeout/);
  assert.equal(open.size, 0);
}
// 6) parallelFrames: il player 1 si blocca → si continua col player 2 (sano), il player 1 è ricreato; frame completi e in ordine
{
  const list = Array.from({ length: 14 }, (_, i) => fr(i)), st = newStats(), re = [], why = [];
  const p2 = fakeVideo({ slow: 1 }); const got = [];
  for await (const vf of parallelFrames([fakeVideo({ hangAt: 3 }), p2], list, st, null, { maxFlight: 4, onFallback: (w) => why.push(w), reopen: async (p) => { re.push(p); return fakeVideo(); } })) { got.push(vf.ts); vf.close(); }
  assert.deepEqual(got, list.map((f) => f.ts));
  assert.equal(st.fellBack, true); assert.match(why[0], /player 1: seek timeout/);
  assert.equal(st.soloPlayer, 2, 'continua il player 2'); assert.deepEqual(re, [0], 'player 1 ricreato');
  assert.equal(open.size, 0);
}
// 7) parallelFrames: entrambi bloccati, il ricreato si blocca di nuovo → SeekTimeout propagato, nessun frame aperto
{
  const list = Array.from({ length: 10 }, (_, i) => fr(i)), st = newStats();
  await assert.rejects((async () => { for await (const vf of parallelFrames([fakeVideo({ hangAt: 2 }), fakeVideo({ hangAt: 2 })], list, st, null, { reopen: async () => fakeVideo({ hangAt: 1 }) })) vf.close(); })(), (e) => isSeekTimeout(e));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(open.size, 0);
}
console.log('frames.test: OK');
