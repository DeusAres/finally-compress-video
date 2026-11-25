// Run: node --test app/lib/queue.test.mjs — logica pura della coda (app/lib/queue.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newQueue, addItems, removeItem, retryItem, nextItem, matchFiles, restoreQueue, uniqueOutName, readyToSave, keepNames,
  itemLabel, queueStats, summaryLines, serialize, ST, sameKey, pending } from './queue.js';

const F = (name, size, lastModified = 1000) => ({ name, size, lastModified });
const a = F('IMG_1.MOV', 100 * 1048576), b = F('IMG_2.MOV', 50 * 1048576), c = F('IMG_3.MOV', 80 * 1048576);

test('FIFO: ordine di aggiunta, aggiunte durante il lavoro in fondo, niente doppioni', () => {
  const q = newQueue({ app: 'v0.36.0' });
  const r = addItems(q, [a, b, a]);
  assert.equal(r.added.length, 2); assert.equal(r.dup.length, 1);
  assert.deepEqual(q.items.map((it) => it.key.name), ['IMG_1.MOV', 'IMG_2.MOV']);
  q.items[0].status = ST.RUN;
  addItems(q, [c, b]);
  assert.deepEqual(q.items.map((it) => it.id), [1, 2, 3]);
  assert.equal(nextItem(q).key.name, 'IMG_2.MOV'); // la voce in corso non è «prossima»
  q.items[1].status = ST.DONE;
  assert.equal(nextItem(q).key.name, 'IMG_3.MOV');
  assert.equal(nextItem(q, (id) => id !== 3), null); // senza File: saltata
  assert.equal(pending(q).length, 2);
});

test('stesso nome ma peso o data diversi = file diversi', () => {
  const q = newQueue();
  addItems(q, [a, F('IMG_1.MOV', a.size, 2000), F('IMG_1.MOV', a.size + 1)]);
  assert.equal(q.items.length, 3);
  assert.ok(sameKey(q.items[0].key, { name: 'IMG_1.MOV', size: a.size, lastModified: 1000 }));
});

test('rimozione: mai la voce in corso', () => {
  const q = newQueue(); addItems(q, [a, b, c]);
  q.items[0].status = ST.RUN;
  assert.equal(removeItem(q, 1), null);
  assert.equal(removeItem(q, 2).key.name, 'IMG_2.MOV');
  assert.equal(removeItem(q, 99), null);
  assert.deepEqual(q.items.map((it) => it.id), [1, 3]);
});

test('riprova: solo errore/annullata, torna in attesa al suo posto', () => {
  const q = newQueue(); addItems(q, [a, b]);
  q.items[0].status = ST.ERR; q.items[0].error = 'boom';
  assert.equal(retryItem(q, 2), false);
  assert.equal(retryItem(q, 1), true);
  assert.equal(q.items[0].status, ST.WAIT); assert.equal(q.items[0].error, undefined);
  assert.equal(nextItem(q).id, 1);
});

test('ripresa: voce in corso → in attesa (interrotta), risultato mancante → in attesa, riabbinamento per nome+peso+data', () => {
  const q = newQueue({ settings: { bitrateMbps: 8 } }); addItems(q, [a, b, c]);
  q.items[0].status = ST.DONE; q.items[0].result = { opfsName: 'IMG_1_8M.mov', inMB: 100, outMB: 40, pct: 60, timeS: 30, predMB: 41, predS: 28 };
  q.items[1].status = ST.RUN;
  const saved = JSON.parse(JSON.stringify(serialize(q)));
  const r = restoreQueue(saved, { resultExists: (it) => it.id === 1 });
  assert.equal(r.items[0].status, ST.DONE);
  assert.equal(r.items[1].status, ST.WAIT); assert.equal(r.items[1].interrupted, true);
  assert.equal(r.nextId, 4);
  const lost = restoreQueue(saved, { resultExists: () => false });
  assert.equal(lost.items[0].status, ST.WAIT); assert.equal(lost.items[0].lost, true); assert.equal(lost.items[0].result, undefined);
  assert.equal(restoreQueue({ v: 99, items: [] }), null);
  assert.equal(restoreQueue(null), null);
  // riabbinamento: i File scelti di nuovo tornano alle voci senza file; un file nuovo resta da aggiungere; uno con data diversa è nuovo
  const has = new Set();
  const m = matchFiles(r, [c, F('IMG_2.MOV', b.size, 1000), a, F('IMG_3.MOV', c.size, 5)], (it) => it.status === ST.WAIT && !has.has(it.id));
  assert.deepEqual(m.matched.map(([it]) => it.id), [3, 2]);
  assert.deepEqual(m.rest.map((f) => f.lastModified), [5]);
});

test('nomi di uscita unici', () => {
  assert.equal(uniqueOutName(new Set(), 'x.mov'), 'x.mov');
  assert.equal(uniqueOutName(new Set(['x.mov']), 'x.mov'), 'x_2.mov');
  assert.equal(uniqueOutName(['x.mov', 'x_2.mov'], 'x.mov'), 'x_3.mov');
  assert.equal(uniqueOutName(['noext'], 'noext'), 'noext_2');
});

test('risultati da salvare, nomi OPFS da tenere, statistiche, etichette e riassunto', () => {
  const q = newQueue(); addItems(q, [a, b, c]);
  q.items[0].status = ST.DONE; q.items[0].result = { opfsName: 'o1.mov', inMB: 100, outMB: 40, pct: 60, timeS: 30, predMB: 41, predS: 28 };
  q.items[1].status = ST.ERR; q.items[1].error = 'Errore: boom';
  q.items[2].status = ST.DONE; q.items[2].result = { opfsName: 'o3.mov', inMB: 80, outMB: 20, pct: 75, timeS: 20, predMB: 22, predS: 25 }; q.items[2].saved = true;
  assert.deepEqual(readyToSave(q).map((it) => it.id), [1]);
  assert.deepEqual(keepNames(q), ['o1.mov']); assert.deepEqual(keepNames(null), []);
  const s = queueStats(q);
  assert.deepEqual([s.n, s.done, s.err, s.toSave], [3, 2, 1, 1]);
  assert.equal(Math.round(s.pct), Math.round((1 - 60 / 180) * 100));
  assert.equal(itemLabel(q, 2), '[2/3 IMG_2.MOV]'); assert.equal(itemLabel(q, 9), '');
  const L = summaryLines(q);
  assert.match(L[0], /^CODA: 3 video · fatti 2 · errori 1/);
  assert.equal(L.length, 2 + 3);
  assert.match(L[2], /IMG_1\.MOV .*100\.0 → 40\.0 .*−60 .*0:30 .*peso 41\.0\/40\.0 MB · tempo 0:28\/0:30/);
  assert.match(L[3], /Errore: Errore: boom/);
  assert.ok(L.slice(1).every((l) => l.split('|').length === 6));
});
