// Test Node del ciclo di vita dei VideoFrame in frames.js (v0.35.4): nessun frame resta aperto quando un player fallisce.
// Uso: node app/lib/frames.test.mjs
import assert from 'node:assert/strict';

const open = new Set();
globalThis.VideoFrame = class { constructor(src, o) { this.ts = o.timestamp; this.mt = src?._mt; open.add(this); } close() { open.delete(this); } };
const { warmPlayers, parallelFrames, seekFrames, newStats, _setSeekTimeout, isSeekTimeout, isUnverified, withSpan } = await import('./frames.js');
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

// ---- v0.36.3: player simulato su una griglia VFR (timescale 600 come gli iPhone: 20 tick = 33.3 ms, 25 tick = 41.7 ms) ----
// Il seek presenta il frame il cui intervallo contiene l'istante; `glitch`: indice → spostamenti (in frame) dei prossimi seek che
// cadono su quel frame (consumati uno per seek, come i mediaTime spostati del log IMG_6887); `always`: indice → spostamento fisso.
const tick = (n) => Math.round(n * 1e6 / 600);
function vfrList(n, long = new Set()) { const out = []; let t = tick(600 * 10); for (let i = 0; i < n; i++) { const d = long.has(i) ? 25 : 20; out.push({ ts: tick(Math.round(t * 600 / 1e6)), dur: tick(d) }); t += tick(d); } return out; }
function gridVideo(list, { glitch = new Map(), always = new Map(), seeks = [] } = {}) {
  const ls = new Map(); let cbs = []; const g = new Map([...glitch].map(([k, v]) => [k, [...v]]));
  const v = {
    _mt: null, duration: 30,
    addEventListener(t, f) { (ls.get(t) || ls.set(t, new Set()).get(t)).add(f); },
    removeEventListener(t, f) { ls.get(t)?.delete(f); },
    requestVideoFrameCallback(f) { cbs.push(f); },
    set currentTime(t) {
      const us = t * 1e6; let i = 0; while (i + 1 < list.length && list[i + 1].ts <= us + 0.5) i++;
      if (us < list[0].ts) i = -1;
      let shown = i; seeks.push(i);
      if (i >= 0 && g.get(i)?.length) shown = i + g.get(i).shift(); else if (always.has(i)) shown = i + always.get(i);
      const mt = shown < 0 ? 9.5 : list[Math.max(0, Math.min(list.length - 1, shown))].ts / 1e6;
      setTimeout(() => { v._mt = mt; const c = cbs; cbs = []; c.forEach((f) => f(0, { mediaTime: mt })); for (const f of [...(ls.get('seeked') || [])]) f(); }, 0);
    },
  };
  return v;
}
const collect = async (gen) => { const got = []; for await (const vf of gen) { got.push({ ts: vf.ts, mt: vf.mt, unv: isUnverified(vf) }); vf.close(); } return got; };
const exact = (got, list) => { assert.deepEqual(got.map((x) => x.ts), list.map((f) => f.ts), 'tutti i frame, in ordine'); got.forEach((x, k) => assert.ok(Math.abs(x.mt - list[k].ts / 1e6) < 1e-6, `frame ${k}: contenuto ${x.mt} ≠ atteso ${list[k].ts / 1e6}`)); };

// 8) regressione IMG_6887: mediaTime spostati di +7/+2/−1/+2/−1 frame attorno a 10.4 s (anche due volte di fila sullo stesso frame),
//    frame da 42 ms vicino: il sequenziale li recupera tutti con i nuovi seek guidati, nessun frame sbagliato consegnato
{
  const list = vfrList(40, new Set([3, 4, 17, 30])), st = newStats(); st.players = [st];
  const glitch = new Map([[13, [7, 2]], [15, [-1, 2]], [19, [-1]], [22, [1]], [25, [3, 3, 3]]]); // 22: +1 (prima accettato come «ok»)
  const got = await collect(seekFrames(gridVideo(list, { glitch }), list, st, null));
  exact(got, list);
  assert.equal(st.unverified || 0, 0); assert.equal(st.recovered, 5, 'cinque frame recuperati');
  assert.ok(st.off >= 9, 'gli spostamenti sono contati come fuori posto'); assert.equal(open.size, 0);
}
// 9) frame sempre sbagliato su questo player → nuovi seek inutili → <video> ricreato (budget) → frame giusto
{
  const list = vfrList(20), st = newStats(); st.players = [st]; const re = [], why = [];
  const got = await collect(seekFrames(gridVideo(list, { always: new Map([[7, 2]]) }), list, st, null, { reopen: async (p) => { re.push(p); return gridVideo(list); }, onReopen: (p, e) => why.push(e.message) }));
  exact(got, list);
  assert.deepEqual(re, [0]); assert.match(why[0], /frame 7 non verificato dopo 4 seek/); assert.equal(st.reopenBad, 1); assert.equal(open.size, 0);
}
// 10) irrecuperabile anche dopo la ricreazione → errore FramesUnverified; il frame sbagliato NON è consegnato, i precedenti sì e giusti
{
  const list = vfrList(20), st = newStats(); st.players = [st]; const got = [];
  await assert.rejects((async () => { for await (const vf of seekFrames(gridVideo(list, { always: new Map([[9, -3]]) }), list, st, null, { base: 100, reopen: async () => gridVideo(list, { always: new Map([[9, -3]]) }) })) { got.push({ ts: vf.ts, mt: vf.mt }); vf.close(); } })(),
    (e) => e.name === 'FramesUnverified' && /frame 109 .*non verificabile/.test(e.message));
  exact(got, list.slice(0, 9)); assert.equal(st.unverified, 1); assert.deepEqual(st.unvSamples[0].slice(0, 2), [109, +(list[9].ts / 1e6).toFixed(4)]);
  assert.equal(open.size, 0);
}
// 11) prove per scena (onBad 'mark', senza ricreare): consegnato ma SEGNATO (escluso dalla metrica); gli altri verificati
{
  const list = vfrList(12), st = newStats(); st.players = [st];
  const got = await collect(seekFrames(gridVideo(list, { always: new Map([[4, 1]]) }), list, st, null, { onBad: 'mark', reopenBad: false, reopen: async () => assert.fail('non si ricrea nelle prove') }));
  assert.deepEqual(got.map((x) => x.unv), got.map((_, k) => k === 4)); assert.equal(st.unverified, 1); assert.equal(open.size, 0);
}
// 12) parallelFrames: il player 2 dà sempre un frame spostato → fallback a 1 player sano che lo recupera; budget di ricreazioni condiviso
{
  const list = vfrList(30, new Set([10, 11])), st = newStats(), why = [], budget = { reopens: 0, max: 3 };
  const got = await collect(parallelFrames([gridVideo(list, { glitch: new Map([[6, [2]]]) }), gridVideo(list, { always: new Map([[11, -2]]) })], list, st, null, { maxFlight: 4, budget, onFallback: (w) => why.push(w), reopen: async () => assert.fail('player sano: nessuna ricreazione') }));
  exact(got, list);
  assert.equal(st.fellBack, true); assert.match(why[0], /player 2: frame 11 non verificato dopo 4 seek/);
  assert.equal(st.unverified || 0, 0); assert.equal(st.recovered, 1, "frame 6 recuperato dal player 1"); assert.equal(budget.reopens, 0); assert.equal(open.size, 0);
}
// 13) withSpan: durata del campione più lunga della distanza dal frame successivo (VFR/riordino) → intervallo = distanza
{
  const w = withSpan([{ ts: 0, dur: 41667 }, { ts: 33333, dur: 33333 }, { ts: 66667, dur: 41667 }]);
  assert.deepEqual(w.map((f) => f.span), [33333, undefined, undefined]);
}
// ---- v0.37 ----
// 14) IMG_7245: frame 0 al centro presenta 0.0333 (frame 2) invece di 0 → nuovi seek a ts esatto / ts+1 ms lo recuperano senza ricreare
function firstBad(list, seeks = []) { // come gridVideo, ma un seek nel frame 0 oltre ts+1.5 ms presenta il frame 2
  const v = gridVideo(list, { seeks }), set = Object.getOwnPropertyDescriptor(v, 'currentTime').set;
  Object.defineProperty(v, 'currentTime', { set(t) { set.call(v, t * 1e6 < list[0].ts + 1500 || t * 1e6 >= list[1].ts ? t : list[2].ts / 1e6 + 1e-4); } });
  return v;
}
{
  const list = Array.from({ length: 20 }, (_, i) => fr(i)), st = newStats(); st.players = [st];
  const got = await collect(seekFrames(firstBad(list), list, st, null, { reopen: async () => assert.fail('nessuna ricreazione per il frame 0') }));
  exact(got, list); assert.equal(st.recovered, 1); assert.equal(st.unverified || 0, 0); assert.equal(open.size, 0);
  const s2 = newStats(), why = [];
  exact(await collect(parallelFrames([firstBad(list), gridVideo(list)], list, s2, null, { onFallback: (w) => why.push(w) })), list);
  assert.equal(s2.fellBack, false, 'frame 0 recuperato dal player stesso, nessun fallback'); assert.equal(open.size, 0);
}
// 15) dopo un fallback (frame non verificato sul player 2) si TORNA a 2 player dopo rejoinAfter frame in sequenza
{
  const list = vfrList(80), st = newStats(), why = [], rj = [], s1 = [], s2 = [];
  const got = await collect(parallelFrames([gridVideo(list, { seeks: s1 }), gridVideo(list, { always: new Map([[11, -2]]), seeks: s2 })], list, st, null, { maxFlight: 4, rejoinAfter: 10, onFallback: (w, o) => why.push([w, o.final]), onRejoin: (o) => rj.push(o) }));
  exact(got, list);
  assert.equal(st.falls, 1); assert.equal(st.rejoined, 1); assert.equal(why[0][1], false, 'fallback non definitivo'); assert.equal(rj[0].players, 2);
  assert.equal(st.soloFrames, 10, '10 frame a 1 player, poi di nuovo 2'); assert.ok(Math.max(...s2) > 60, 'il player 2 lavora fino alla fine');
  assert.ok(s2.filter((i) => i > 30).length > 15); assert.equal(open.size, 0);
}
// 16) 3 player: round-robin p, p+3, … e ordine di uscita corretto
{
  const list = vfrList(45), st = newStats(), sk = [[], [], []];
  const got = await collect(parallelFrames(sk.map((seeks) => gridVideo(list, { seeks })), list, st, null, { maxFlight: 6 }));
  exact(got, list); assert.equal(st.fellBack, false);
  sk.forEach((s, p) => { assert.equal(s.length, 15); assert.ok(s.every((i) => i % 3 === p), `player ${p + 1}: indici ${s}`); });
  assert.deepEqual(st.players.map((q) => q.n), [15, 15, 15]); assert.equal(open.size, 0);
}
// 17) 3 player, il terzo sbaglia sempre dal frame 5: due fallback → escluso, si continua con 2 player (non con 1)
{
  const list = vfrList(90), st = newStats(), why = [], rj = [];
  const bad3 = new Map(Array.from({ length: 85 }, (_, k) => [k + 5, 1]));
  const got = await collect(parallelFrames([gridVideo(list), gridVideo(list), gridVideo(list, { always: bad3 })], list, st, null, { maxFlight: 6, rejoinAfter: 8, onFallback: (w, o) => why.push(o.final), onRejoin: (o) => rj.push(o.players) }));
  exact(got, list); assert.equal(st.falls, 2); assert.deepEqual(why, [false, false]); assert.deepEqual(rj, [3, 2]); assert.equal(st.soloFrames, 16);
  assert.equal(open.size, 0);
}
console.log('frames.test: OK');
