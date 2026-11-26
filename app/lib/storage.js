// Spazio occupato (v0.37.1): REGISTRO (ledger) di tutto ciò che l'app tiene sul telefono + scansione di confronto + pulizia.
// Registro: ogni oggetto persistente si iscrive quando nasce (opfs.js: risultato; jobstore.js: segmenti dell'export; queuestore.js:
// manifest della coda) con tipo, proprietario, dimensione e stato; è salvato in IndexedDB (db «fcv-ledger») e lavora la pulizia.
// Scansione (OPFS, IndexedDB, Cache Storage, localStorage/sessionStorage) confrontata col registro: ciò che NON è iscritto è orfano
// (stato «libero»). Stati: inuse (scrittura in corso) · resumable (export riprendibile / coda) · unsaved (risultato da salvare)
// · free (liberabile senza perdere nulla). Il registro non lancia mai: un errore di storage non deve fermare l'app.
export const STATE = { INUSE: 'inuse', RESUMABLE: 'resumable', UNSAVED: 'unsaved', FREE: 'free' };
export const LEDGER_DB = 'fcv-ledger', LEDGER_STORE = 'entries';
export const fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : (n | 0) + ' B');
const idOf = (type, path) => `${type}:${path}`;

// ---------- registro ----------
/** Store persistente su IndexedDB (db «fcv-ledger»); ogni metodo assorbe gli errori. */
export function idbLedgerStore(idb = globalThis.indexedDB) {
  const open = () => new Promise((res, rej) => {
    const r = idb.open(LEDGER_DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(LEDGER_STORE)) r.result.createObjectStore(LEDGER_STORE, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    try { return await new Promise((res, rej) => { const t = db.transaction(LEDGER_STORE, mode), r = fn(t.objectStore(LEDGER_STORE)); t.oncomplete = () => res(r?.result); t.onerror = t.onabort = () => rej(t.error); }); } finally { db.close(); }
  };
  return { loadAll: () => run('readonly', (s) => s.getAll()), put: (e) => run('readwrite', (s) => s.put(e)), del: (id) => run('readwrite', (s) => s.delete(id)) };
}

export function createLedger(store = null) {
  const m = new Map(); let chain = Promise.resolve(), loaded = false;
  const persist = (fn) => { if (!store) return; chain = chain.then(fn).catch(() => {}); };
  return {
    /** Carica il registro salvato (una volta). */
    async load() { if (loaded) return; loaded = true; try { for (const e of (await store?.loadAll()) || []) if (!m.has(e.id)) m.set(e.id, e); } catch { /* registro non leggibile: si riparte vuoto */ } },
    /** Iscrive o aggiorna (merge): {type:'opfs'|'idb', path, kind, owner?, size?, state}. */
    set(e) {
      try { const id = idOf(e.type, e.path), n = { ...m.get(id), ...e, id, t: Date.now() }; m.set(id, n); persist(() => store.put(n)); } catch { /* mai bloccare l'app */ }
    },
    get: (type, path) => m.get(idOf(type, path)) || null,
    drop(type, path) { try { const id = idOf(type, path); if (m.delete(id)) persist(() => store.del(id)); } catch { /* idem */ } },
    list: () => [...m.values()],
    /** Avvio: nessun processo è più «in uso» (la sessione precedente è finita o è stata uccisa): i segmenti restano riprendibili, il resto è libero. */
    settle() { for (const e of this.list()) if (e.state === STATE.INUSE) { if (e.kind === 'segment') this.set({ ...e, state: STATE.RESUMABLE }); else this.drop(e.type, e.path); } },
    flush: () => chain,
  };
}
/** Registro dell'app (IndexedDB). In Node senza indexedDB resta in memoria. */
export const ledger = createLedger(typeof indexedDB !== 'undefined' ? idbLedgerStore() : null);

// ---------- scansione ----------
export function sizeOf(v, depth = 0) {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length * 2;
  if (typeof v === 'number') return 8; if (typeof v === 'boolean') return 4;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v.size;
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v.byteLength;
  if (typeof v === 'object' && depth < 8) { let n = 0; for (const k of Object.keys(v)) n += k.length * 2 + sizeOf(v[k], depth + 1); return n; }
  return 0;
}
async function dirSize(dir) {
  let size = 0, files = 0;
  for await (const [, h] of dir.entries()) {
    if (h.kind === 'file') { try { size += (await h.getFile()).size; files++; } catch { /* sparito */ } }
    else { const r = await dirSize(h); size += r.size; files += r.files; }
  }
  return { size, files };
}
const idbReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function openIdb(idb, name) { const db = await idbReq(idb.open(name)); return db; }

/** Voci del livello superiore di OPFS: {type:'opfs', path, dir, size, files}. */
export async function scanOpfs(storage) {
  const out = []; let root; try { root = await storage.getDirectory(); } catch { return out; }
  for await (const [name, h] of root.entries()) {
    try {
      if (h.kind === 'file') out.push({ type: 'opfs', path: name, dir: false, size: (await h.getFile()).size, files: 1 });
      else { const r = await dirSize(h); out.push({ type: 'opfs', path: name, dir: true, size: r.size, files: r.files }); }
    } catch { /* voce bloccata da un altro tab */ }
  }
  return out;
}
/** Un elemento per store di ogni database (esclusa la sede del registro): {type:'idb', path:'db/store', count, size}. */
export async function scanIdb(idb) {
  const out = []; if (!idb) return out;
  let names = []; try { names = (await idb.databases?.())?.map((d) => d.name) || ['fcv']; } catch { names = ['fcv']; }
  for (const name of names.filter((n) => n && n !== LEDGER_DB)) {
    let db; try { db = await openIdb(idb, name); } catch { continue; }
    try {
      for (const s of [...db.objectStoreNames]) {
        try { const rows = await new Promise((res, rej) => { const t = db.transaction(s, 'readonly'), r = t.objectStore(s).getAll(); t.oncomplete = () => res(r.result); t.onerror = t.onabort = () => rej(t.error); });
          out.push({ type: 'idb', path: `${name}/${s}`, count: rows.length, size: rows.reduce((a, r) => a + sizeOf(r), 0) }); } catch { /* store illeggibile */ }
      }
    } finally { db.close(); }
  }
  return out;
}
export async function scanCaches(caches) {
  const out = []; if (!caches) return out;
  let names = []; try { names = await caches.keys(); } catch { return out; }
  for (const name of names) {
    let size = 0, count = 0;
    try {
      const c = await caches.open(name);
      for (const rq of await c.keys()) {
        count++; const r = await c.match(rq); if (!r) continue;
        try { size += (await r.clone().blob()).size; } catch { size += +r.headers?.get('content-length') || 0; }
      }
    } catch { /* cache illeggibile */ }
    out.push({ type: 'cache', path: name, count, size });
  }
  return out;
}
export function scanWeb(type, st) {
  const out = []; if (!st) return out;
  try { for (let i = 0; i < st.length; i++) { const k = st.key(i); out.push({ type, path: k, size: (k.length + (st.getItem(k) || '').length) * 2 }); } } catch { /* storage bloccato */ }
  return out;
}

/**
 * Scansione + confronto col registro. env = {storage, indexedDB, caches, localStorage, sessionStorage}.
 * ctx = {busy, currentCache, keep:{opfs:[nomi protetti: 'jobs', risultati non salvati], idb:['fcv/kv']}}.
 * Ritorna {est:{usage,quota,persisted}, items:[{type,path,label,kind,state,size,files?,count?,owner?}], used, free}.
 */
export async function scanAll(env, ctx = {}, led = ledger) {
  await led.load();
  const keepO = new Set(ctx.keep?.opfs || []), keepI = new Set(ctx.keep?.idb || []);
  let est = { usage: 0, quota: 0, persisted: null };
  try { const e = await env.storage?.estimate?.(); if (e) { est.usage = e.usage || 0; est.quota = e.quota || 0; } } catch {}
  try { est.persisted = (await env.storage?.persisted?.()) ?? null; } catch {}
  const [o, i, c] = await Promise.all([scanOpfs(env.storage || {}), scanIdb(env.indexedDB), scanCaches(env.caches)]);
  const items = [];
  const settleState = (e, kind, protectedState) => {
    let st = e?.state, k = e?.kind || kind;
    if (st === STATE.INUSE && !ctx.busy) st = k === 'segment' ? STATE.RESUMABLE : STATE.FREE; // stato rimasto da una sessione finita
    if (!st) st = STATE.FREE;
    if (protectedState && st === STATE.FREE) st = protectedState;
    return { kind: k, state: st, owner: e?.owner };
  };
  for (const x of o) {
    const e = led.get('opfs', x.path), prot = keepO.has(x.path) && !(x.dir && !x.files);
    const isJob = x.path === 'jobs', kind = isJob ? 'segment' : e?.kind === 'result' || prot ? 'result' : 'temp';
    let r = settleState(e, kind, prot ? (isJob ? STATE.RESUMABLE : STATE.UNSAVED) : null);
    if (ctx.busy && r.state === STATE.FREE) r = { ...r, state: STATE.INUSE }; // file in scrittura non iscritto: mai toccarlo durante l'export
    items.push({ ...x, ...r, label: isJob ? `Export interrotto (${x.files} file)` : kind === 'result' ? `Risultato ${x.path}` : `${x.dir ? 'Cartella' : 'File'} temporaneo ${x.path}` });
  }
  for (const x of i) {
    const e = led.get('idb', x.path), prot = keepI.has(x.path);
    const r = settleState(e, 'queue', prot ? STATE.RESUMABLE : null);
    items.push({ ...x, ...r, kind: 'queue', label: `Database ${x.path}${x.count ? ` (${x.count} voci)` : ''}` });
  }
  for (const x of c) {
    const cur = x.path === ctx.currentCache;
    items.push({ ...x, kind: 'cache', state: cur ? STATE.INUSE : STATE.FREE, label: cur ? `Cache offline ${x.path}` : `Cache vecchia ${x.path}` });
  }
  for (const [t, st, n] of [['local', env.localStorage, 'localStorage'], ['session', env.sessionStorage, 'sessionStorage']])
    for (const x of scanWeb(t, st)) items.push({ ...x, kind: 'pref', state: STATE.INUSE, label: `${n}: ${x.path}` });
  // voci iscritte ma sparite dal disco: via dal registro
  const seen = new Set(items.map((x) => idOf(x.type, x.path)));
  for (const e of led.list()) if (!seen.has(e.id) && (e.type === 'opfs' || e.type === 'idb') && !(ctx.busy && e.state === STATE.INUSE)) led.drop(e.type, e.path);
  const used = items.reduce((a, x) => a + x.size, 0), free = items.filter((x) => x.state === STATE.FREE).reduce((a, x) => a + x.size, 0);
  return { est, items, used, free };
}

// ---------- pulizia ----------
/** Elimina una voce dalla scansione. Ritorna true se rimossa. Le voci «inuse» si rifiutano sempre (ctx.busy). */
export async function removeItem(env, item, led = ledger, { force = false } = {}) {
  if (item.state === STATE.INUSE && !force) return false;
  try {
    if (item.type === 'opfs') { const root = await env.storage.getDirectory(); await root.removeEntry(item.path, { recursive: true }); }
    else if (item.type === 'idb') {
      const [name, store] = [item.path.slice(0, item.path.indexOf('/')), item.path.slice(item.path.indexOf('/') + 1)];
      const db = await openIdb(env.indexedDB, name);
      try { await new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).clear(); t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); }); } finally { db.close(); }
    }
    else if (item.type === 'cache') await env.caches.delete(item.path);
    else if (item.type === 'local') env.localStorage.removeItem(item.path);
    else if (item.type === 'session') env.sessionStorage.removeItem(item.path);
    led.drop(item.type, item.path);
    return true;
  } catch (e) { if (e?.name === 'NotFoundError') { led.drop(item.type, item.path); return true; } return false; }
}
/** «Libera spazio»: elimina tutto ciò che è libero (orfani, temporanei, cache vecchie). Ritorna {n, bytes}. */
export async function freeSpace(env, scan, led = ledger) {
  let n = 0, bytes = 0;
  for (const x of scan.items) if (x.state === STATE.FREE && await removeItem(env, x, led)) { n++; bytes += x.size; }
  return { n, bytes };
}
/** «Svuota tutto»: ogni voce non in uso (anche risultati non salvati, export riprendibile, coda, cache offline, preferenze). */
export async function clearAll(env, scan, led = ledger) {
  let n = 0, bytes = 0;
  for (const x of scan.items) if (await removeItem(env, x, led)) { n++; bytes += x.size; }
  return { n, bytes };
}
/** Testo di conferma di «Svuota tutto»: cosa si perde davvero. */
export function lossLines(scan) {
  const by = (s) => scan.items.filter((x) => x.state === s), sum = (a) => a.reduce((t, x) => t + x.size, 0), out = [];
  const u = by(STATE.UNSAVED), r = by(STATE.RESUMABLE);
  if (u.length) out.push(`${u.length} ${u.length === 1 ? 'risultato non salvato' : 'risultati non salvati'} (${fmtBytes(sum(u))})`);
  for (const x of r) out.push(x.kind === 'segment' ? `l'export riprendibile (${fmtBytes(x.size)})` : 'la coda salvata');
  const c = scan.items.filter((x) => x.kind === 'cache' && x.state === STATE.INUSE); if (c.length) out.push("la cache offline (l'app la riscarica alla prossima apertura)");
  if (scan.items.some((x) => x.kind === 'pref')) out.push('le preferenze salvate');
  return out;
}
/** Raggruppa le voci per la tendina «Dettagli»: [{title, items}] (gruppi vuoti omessi). */
export function groupItems(items) {
  const G = [['Risultati da salvare', (x) => x.kind === 'result'], ['Export riprendibile', (x) => x.kind === 'segment'], ['Temporanei e orfani', (x) => x.type === 'opfs' && x.kind === 'temp'],
    ['IndexedDB (coda)', (x) => x.type === 'idb'], ['Cache offline', (x) => x.type === 'cache'], ['localStorage / sessionStorage', (x) => x.type === 'local' || x.type === 'session']];
  return G.map(([title, f]) => ({ title, items: items.filter(f) })).filter((g) => g.items.length);
}
