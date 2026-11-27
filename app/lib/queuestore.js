// Persistenza della coda (v0.36): manifest della coda in IndexedDB (db «fcv», store «kv», chiave «queue»).
// Solo il manifest (nomi, peso, data, stato, impostazioni, risultati): i File scelti NON sono persistenti in Safari e vanno
// riselezionati; i risultati restano in OPFS (radice) finché salvati, i segmenti della voce interrotta in OPFS jobs/current.
// Ogni errore (IndexedDB non disponibile, navigazione privata, quota) è assorbito: la coda funziona lo stesso, solo non si riprende.
import { ledger, STATE } from './storage.js?v=0.38.3';
const DB = 'fcv', STORE = 'kv', KEY = 'queue';

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('IndexedDB bloccato'));
  });
}
async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => res(req?.result); t.onerror = t.onabort = () => rej(t.error || new Error('transazione IndexedDB fallita'));
    });
  } finally { db.close(); }
}

/** Manifest della coda salvato, o null. */
export async function loadQueue() { try { return (await tx('readonly', (s) => s.get(KEY))) || null; } catch { return null; } }

let chain = Promise.resolve();
/** Salva (in ordine: le scritture non si sorpassano). Ritorna una promise che non rifiuta mai: {ok, error?}. */
export function saveQueue(q) {
  const snap = q ? JSON.parse(JSON.stringify(q)) : null;
  if (snap) ledger.set({ type: 'idb', path: `${DB}/${STORE}`, kind: 'queue', owner: 'queue', state: STATE.RESUMABLE, size: JSON.stringify(snap).length * 2 }); else ledger.drop('idb', `${DB}/${STORE}`); // registro
  chain = chain.then(() => tx('readwrite', (s) => (snap ? s.put(snap, KEY) : s.delete(KEY)))).then(() => ({ ok: true }), (e) => ({ ok: false, error: e?.message || String(e) }));
  return chain;
}
export const clearQueue = () => saveQueue(null);
