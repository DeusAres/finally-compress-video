// Run: node --test app/lib/storage.test.mjs — registro, scansione di confronto e pulizia dello spazio (app/lib/storage.js) con OPFS/IDB/Cache finti.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, scanAll, freeSpace, clearAll, removeItem, lossLines, groupItems, sizeOf, fmtBytes, STATE } from './storage.js';

// --- finti ---
const file = (n) => ({ kind: 'file', getFile: async () => ({ size: n }) });
function dir(tree) {
  return {
    kind: 'directory', tree,
    async *entries() { for (const [k, v] of Object.entries(this.tree)) yield [k, v]; },
    async removeEntry(name) { if (!(name in this.tree)) { const e = new Error('nf'); e.name = 'NotFoundError'; throw e; } delete this.tree[name]; },
  };
}
const mkRoot = () => dir({ 'jobs': dir({ current: dir({ 'seg-0000.bin': file(1000), 'manifest.json': file(50) }) }), 'out_ok.mov': file(5000), 'old_tmp.mov': file(700), 'empty': dir({}) });
function fakeIdb(dbs) { // {nome: {store: [righe]}}
  return {
    databases: async () => Object.keys(dbs).map((name) => ({ name })),
    open(name) {
      const r = {}; const db = { objectStoreNames: Object.keys(dbs[name]), close() {},
        transaction(s) { const t = {}; t.objectStore = () => ({ getAll() { const q = {}; setTimeout(() => { q.result = [...dbs[name][s]]; t.oncomplete?.(); }); return q; }, clear() { setTimeout(() => { dbs[name][s].length = 0; t.oncomplete?.(); }); return {}; } }); return t; } };
      setTimeout(() => { r.result = db; r.onsuccess?.(); }); return r;
    },
  };
}
const fakeCaches = (m) => ({ keys: async () => Object.keys(m), delete: async (n) => delete m[n],
  open: async (n) => ({ keys: async () => Object.keys(m[n]), match: async (k) => ({ clone() { return this; }, blob: async () => ({ size: m[n][k] }), headers: new Headers() }) }) });
const fakeWeb = (o) => ({ get length() { return Object.keys(o).length; }, key: (i) => Object.keys(o)[i], getItem: (k) => o[k], removeItem: (k) => { delete o[k]; } });
function env() {
  const root = mkRoot(), idbd = { fcv: { kv: [{ items: [1, 2, 3] }] }, junk: { s: [{ a: 'x'.repeat(100) }] } }, ch = { 'fcv-OLD': { a: 300, b: 200 }, 'fcv-NEW': { a: 1000 } };
  return { root, idbd, ch, e: { storage: { getDirectory: async () => root, estimate: async () => ({ usage: 9000, quota: 100000 }), persisted: async () => true }, indexedDB: fakeIdb(idbd), caches: fakeCaches(ch), localStorage: fakeWeb({ a: '12' }), sessionStorage: fakeWeb({}) } };
}
const memStore = () => { const m = new Map(); return { m, loadAll: async () => [...m.values()], put: async (e) => { m.set(e.id, e); }, del: async (id) => { m.delete(id); } }; };
const find = (sc, t, p) => sc.items.find((x) => x.type === t && x.path === p);

test('registro: set/merge/drop e persistenza', async () => {
  const st = memStore(), l = createLedger(st);
  l.set({ type: 'opfs', path: 'a.mov', kind: 'result', state: STATE.INUSE, size: 0 });
  l.set({ type: 'opfs', path: 'a.mov', size: 10, state: STATE.UNSAVED });
  assert.equal(l.get('opfs', 'a.mov').kind, 'result'); assert.equal(l.get('opfs', 'a.mov').size, 10);
  await l.flush(); assert.equal(st.m.get('opfs:a.mov').state, STATE.UNSAVED);
  const l2 = createLedger(st); await l2.load(); assert.equal(l2.list().length, 1);
  l2.drop('opfs', 'a.mov'); await l2.flush(); assert.equal(st.m.size, 0);
});
test('registro: settle a riavvio (segmenti riprendibili, resto libero)', () => {
  const l = createLedger(null);
  l.set({ type: 'opfs', path: 'jobs', kind: 'segment', state: STATE.INUSE }); l.set({ type: 'opfs', path: 'x.mov', kind: 'result', state: STATE.INUSE });
  l.settle(); assert.equal(l.get('opfs', 'jobs').state, STATE.RESUMABLE); assert.equal(l.get('opfs', 'x.mov'), null);
});
test('scansione: stati, orfani, cache vecchie, totali', async () => {
  const { e } = env(), l = createLedger(null);
  l.set({ type: 'opfs', path: 'jobs', kind: 'segment', state: STATE.RESUMABLE }); l.set({ type: 'opfs', path: 'out_ok.mov', kind: 'result', state: STATE.UNSAVED });
  const sc = await scanAll(e, { currentCache: 'fcv-NEW', keep: { opfs: ['jobs', 'out_ok.mov'], idb: ['fcv/kv'] } }, l);
  assert.equal(find(sc, 'opfs', 'jobs').state, STATE.RESUMABLE); assert.equal(find(sc, 'opfs', 'jobs').size, 1050);
  assert.equal(find(sc, 'opfs', 'out_ok.mov').state, STATE.UNSAVED);
  assert.equal(find(sc, 'opfs', 'old_tmp.mov').state, STATE.FREE);   // orfano: non iscritto
  assert.equal(find(sc, 'opfs', 'empty').state, STATE.FREE);
  assert.equal(find(sc, 'idb', 'fcv/kv').state, STATE.RESUMABLE); assert.equal(find(sc, 'idb', 'junk/s').state, STATE.FREE);
  assert.equal(find(sc, 'cache', 'fcv-OLD').size, 500); assert.equal(find(sc, 'cache', 'fcv-OLD').state, STATE.FREE); assert.equal(find(sc, 'cache', 'fcv-NEW').state, STATE.INUSE);
  assert.equal(find(sc, 'local', 'a').size, 6);
  assert.equal(sc.free, sc.items.filter((x) => x.state === 'free').reduce((a, x) => a + x.size, 0)); assert.ok(sc.free >= 700 + 500);
  assert.deepEqual(sc.est, { usage: 9000, quota: 100000, persisted: true });
});
test('sicurezza: risultato non iscritto ma in coda resta «da salvare»; durante l\'export niente è libero', async () => {
  const { e } = env(), l = createLedger(null);
  let sc = await scanAll(e, { currentCache: 'x', keep: { opfs: ['out_ok.mov'] } }, l); assert.equal(find(sc, 'opfs', 'out_ok.mov').state, STATE.UNSAVED);
  sc = await scanAll(e, { busy: true, currentCache: 'x', keep: { opfs: [] } }, l); assert.equal(find(sc, 'opfs', 'old_tmp.mov').state, STATE.INUSE);
  await freeSpace(e, sc, l); const t = (await e.storage.getDirectory()).tree; assert.ok(t['old_tmp.mov'] && t['out_ok.mov'] && t.jobs); // OPFS intatto in export
});
test('stato «inuse» stantio senza export in corso: segmenti riprendibili, resto libero', async () => {
  const { e } = env(), l = createLedger(null);
  l.set({ type: 'opfs', path: 'jobs', kind: 'segment', state: STATE.INUSE }); l.set({ type: 'opfs', path: 'old_tmp.mov', kind: 'result', state: STATE.INUSE });
  const sc = await scanAll(e, { currentCache: 'x', keep: { opfs: [] } }, l);
  assert.equal(find(sc, 'opfs', 'jobs').state, STATE.RESUMABLE); assert.equal(find(sc, 'opfs', 'old_tmp.mov').state, STATE.FREE);
});
test('«Libera spazio»: toglie solo il libero e aggiorna il registro', async () => {
  const x = env(), l = createLedger(null);
  l.set({ type: 'opfs', path: 'old_tmp.mov', kind: 'result', state: STATE.FREE });
  const sc = await scanAll(x.e, { currentCache: 'fcv-NEW', keep: { opfs: ['jobs', 'out_ok.mov'], idb: ['fcv/kv'] } }, l);
  const r = await freeSpace(x.e, sc, l);
  assert.deepEqual(Object.keys(x.root.tree).sort(), ['jobs', 'out_ok.mov']);
  assert.deepEqual(Object.keys(x.ch), ['fcv-NEW']); assert.equal(x.idbd.junk.s.length, 0); assert.equal(x.idbd.fcv.kv.length, 1);
  assert.ok(r.bytes >= 1200); assert.equal(l.get('opfs', 'old_tmp.mov'), null);
  const sc2 = await scanAll(x.e, { currentCache: 'fcv-NEW', keep: { opfs: ['jobs', 'out_ok.mov'], idb: ['fcv/kv'] } }, l); assert.equal(sc2.free, 0);
});
test('«Elimina» di una voce; «inuse» rifiutato; «Svuota tutto» e testo di perdita', async () => {
  const x = env(), l = createLedger(null);
  const ctx = { currentCache: 'fcv-NEW', keep: { opfs: ['jobs', 'out_ok.mov'], idb: ['fcv/kv'] } };
  let sc = await scanAll(x.e, ctx, l);
  const L = lossLines(sc).join('|'); assert.match(L, /1 risultato non salvato/); assert.match(L, /export riprendibile/); assert.match(L, /coda salvata/);
  assert.equal(await removeItem(x.e, find(sc, 'cache', 'fcv-NEW'), l, {}), false); // in uso
  assert.equal(await removeItem(x.e, find(sc, 'opfs', 'out_ok.mov'), l), true); assert.ok(!x.root.tree['out_ok.mov']);
  sc = await scanAll(x.e, ctx, l); const r = await clearAll(x.e, sc, l);
  assert.ok(r.n > 0); assert.deepEqual(Object.keys(x.root.tree), []); assert.equal(x.idbd.fcv.kv.length, 0);
});
test('gruppi, dimensioni e formati', () => {
  assert.equal(fmtBytes(1048576 * 3), '3.0 MB'); assert.equal(fmtBytes(2048), '2 KB');
  assert.equal(sizeOf({ a: 'xy' }), 2 + 4); assert.equal(sizeOf(new Uint8Array(10)), 10);
  const g = groupItems([{ type: 'opfs', kind: 'temp' }, { type: 'cache', kind: 'cache' }, { type: 'opfs', kind: 'segment' }]);
  assert.deepEqual(g.map((x) => x.title), ['Export riprendibile', 'Temporanei e orfani', 'Cache offline']);
});
