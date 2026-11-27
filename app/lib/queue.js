// Coda di video (v0.36): logica PURA (nessun DOM, nessun File), testata in Node (queue.test.mjs).
// La coda è FIFO: i video si elaborano nell'ordine in cui sono stati aggiunti, quelli aggiunti mentre lavora vanno in fondo.
// Un solo export alla volta (stessa pipeline dell'export singolo, index.html). Lo stato è serializzabile (IndexedDB,
// queuestore.js): i File NON sono persistenti in Safari, quindi una voce si riabbina al suo file per nome + peso + data.
//
// Q = { v, app, created, settings, nextId, items: [Item] }
// Item = { id, key:{name,size,lastModified}, status, info?, result?, error?, saved?, interrupted?, resume? }
//   status: 'attesa' | 'corso' | 'fatto' | 'errore' | 'annullata'
//   info:   metadati letti dal file {dur, W, H, hdr, dv, fps, aacBps, apacBps, apac, meta, exported}
//   result: {outName, opfsName, inMB, outMB, pct, timeS, predMB, predS, sceneBr?, kept?}  (opfsName: file in OPFS finché non salvato;
//            kept = 'light' | 'bigger': nessun file prodotto, tenuto l'originale → outMB = inMB, niente opfsName)
//   saved:  true quando il risultato è stato salvato (o rilasciato): il file OPFS non c'è più
export const QUEUE_VERSION = 1;
export const ST = Object.freeze({ WAIT: 'attesa', RUN: 'corso', DONE: 'fatto', ERR: 'errore', CANCEL: 'annullata' });
export const STATUS_LABEL = Object.freeze({ attesa: 'In attesa', corso: 'In corso', fatto: 'Fatto', errore: 'Errore', annullata: 'Annullata' });

export const keyOf = (f) => ({ name: String(f.name), size: +f.size, lastModified: +f.lastModified || 0 });
export const sameKey = (a, b) => !!(a && b && a.name === b.name && a.size === b.size && a.lastModified === b.lastModified);

/** Nuova coda vuota. */
export function newQueue({ app = '', settings = null, now = Date.now() } = {}) {
  return { v: QUEUE_VERSION, app, created: now, settings, nextId: 1, items: [] };
}

/**
 * Aggiunge file in fondo (FIFO). Un file già in coda (stessa chiave) non viene duplicato.
 * @returns {{added: Item[], dup: object[]}}
 */
export function addItems(q, files) {
  const added = [], dup = [];
  for (const f of files) {
    const key = keyOf(f);
    if (q.items.some((it) => sameKey(it.key, key)) || added.some((it) => sameKey(it.key, key))) { dup.push(key); continue; }
    const it = { id: q.nextId++, key, status: ST.WAIT };
    q.items.push(it); added.push(it);
  }
  return { added, dup };
}

export const findItem = (q, id) => q.items.find((it) => it.id === id) || null;
export const indexOf = (q, id) => q.items.findIndex((it) => it.id === id);

/** Rimuove una voce (mai quella in corso). Ritorna la voce rimossa o null. */
export function removeItem(q, id) {
  const i = indexOf(q, id);
  if (i < 0 || q.items[i].status === ST.RUN) return null;
  return q.items.splice(i, 1)[0];
}

/** Rimette in attesa una voce in errore o annullata (resta al suo posto nella coda). */
export function retryItem(q, id) {
  const it = findItem(q, id);
  if (!it || (it.status !== ST.ERR && it.status !== ST.CANCEL)) return false;
  it.status = ST.WAIT; delete it.error; return true;
}

/** Prossima voce da elaborare: la prima in attesa che ha il suo File (hasFile(id)). FIFO. */
export function nextItem(q, hasFile = () => true) {
  return q.items.find((it) => it.status === ST.WAIT && hasFile(it.id)) || null;
}

/** Voci in attesa (con o senza file). */
export const pending = (q) => q.items.filter((it) => it.status === ST.WAIT || it.status === ST.RUN);

/**
 * Riabbina i File scelti alle voci che ne sono prive (dopo una ricarica: i File non sopravvivono).
 * needsFile(it) dice se la voce aspetta il suo file. Ritorna {matched: [[item, file]], rest: [file]} (rest = file nuovi).
 */
export function matchFiles(q, files, needsFile) {
  const matched = [], rest = [];
  for (const f of files) {
    const key = keyOf(f);
    const it = q.items.find((x) => sameKey(x.key, key));
    if (it) { if (needsFile(it) && !matched.some(([m]) => m === it)) matched.push([it, f]); /* già in coda: ignorato */ }
    else rest.push(f);
  }
  return { matched, rest };
}

/**
 * Normalizza una coda letta da IndexedDB: la voce che era «in corso» quando la pagina è stata uccisa torna «in attesa»
 * (interrupted: riprenderà dai segmenti salvati). resultExists(item) dice se il file risultato è ancora in OPFS: se manca,
 * la voce torna in attesa (il risultato è perso) a meno che fosse già salvata.
 */
export function restoreQueue(saved, { resultExists = () => true } = {}) {
  if (!saved || saved.v !== QUEUE_VERSION || !Array.isArray(saved.items)) return null;
  const q = { ...saved, items: saved.items.map((it) => ({ ...it })) };
  q.nextId = Math.max(q.nextId || 1, ...q.items.map((it) => it.id + 1));
  for (const it of q.items) {
    if (it.status === ST.RUN) { it.status = ST.WAIT; it.interrupted = true; }
    if (it.status === ST.DONE && !it.saved && !resultExists(it)) { it.status = ST.WAIT; it.lost = true; delete it.result; }
  }
  return q;
}

/** Nome di uscita unico fra quelli già presi (OPFS è piatto: due IMG_0001.mov da cartelle diverse non si sovrascrivono). */
export function uniqueOutName(taken, name) {
  const has = (n) => (taken instanceof Set ? taken.has(n) : taken.includes(n));
  if (!has(name)) return name;
  const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let k = 2; ; k++) { const n = `${base}_${k}${ext}`; if (!has(n)) return n; }
}

/** Risultati pronti da salvare (fatto, non ancora salvati). */
export const readyToSave = (q) => q.items.filter((it) => it.status === ST.DONE && !it.saved && it.result?.opfsName); // v0.37.4: «tenuto l'originale» (result.kept) non ha file da salvare

/**
 * v0.37.4: variazione di peso con segno esplicito, virgola decimale e spazio: risparmio 60 → «−60,0 %», file più pesante (−69.3) → «+69,3 %».
 * saved = (1 − uscita/sorgente) × 100. Mai «−-69.3%».
 */
export function fmtPct(saved, digits = 1) {
  if (!Number.isFinite(saved)) return '—';
  const a = Math.abs(saved), t = a.toFixed(digits).replace('.', ',');
  return `${Number(a.toFixed(digits)) === 0 ? '±' : saved > 0 ? '−' : '+'}${t} %`;
}

/** Nomi OPFS da NON cancellare all'avvio / nelle pulizie (risultati della coda non ancora salvati). */
export const keepNames = (q) => (q ? readyToSave(q).map((it) => it.result.opfsName).filter(Boolean) : []);

/** Etichetta del log: «[2/3 IMG_0001.MOV]». */
export function itemLabel(q, id) {
  const i = indexOf(q, id), it = q.items[i];
  return it ? `[${i + 1}/${q.items.length} ${it.key.name}]` : '';
}

/** Conteggi e totali. */
export function queueStats(q) {
  const s = { n: q.items.length, wait: 0, run: 0, done: 0, err: 0, cancel: 0, inMB: 0, outMB: 0, doneInMB: 0, timeS: 0, toSave: 0 };
  for (const it of q.items) {
    s.inMB += it.key.size / 1048576;
    if (it.status === ST.WAIT) s.wait++; else if (it.status === ST.RUN) s.run++; else if (it.status === ST.ERR) s.err++; else if (it.status === ST.CANCEL) s.cancel++;
    else if (it.status === ST.DONE && it.result) { s.done++; s.outMB += it.result.outMB; s.doneInMB += it.result.inMB; s.timeS += it.result.timeS || 0; if (!it.saved && it.result.opfsName) s.toSave++; }
  }
  s.pct = s.doneInMB > 0 ? (1 - s.outMB / s.doneInMB) * 100 : null;
  return s;
}

const p2 = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const l2 = (s, n) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const fT = (s) => { if (!(s >= 0)) return '—'; s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fM = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');

/** Riassunto finale per il log: righe di testo (tabella a colonne fisse, monospazio). */
export function summaryLines(q) {
  const s = queueStats(q), out = [];
  out.push(`CODA: ${s.n} video · fatti ${s.done} · errori ${s.err} · annullati ${s.cancel} · in attesa ${s.wait}${s.done ? ` · ${fM(s.doneInMB)} → ${fM(s.outMB)} MB (${fmtPct(s.pct, 0)}) · tempo ${fT(s.timeS)}` : ''}`);
  const w = Math.min(28, Math.max(4, ...q.items.map((it) => it.key.name.length)));
  out.push(`CODA | ${p2('file', w)} | ${l2('prima → dopo MB', 18)} | ${l2('%', 5)} | ${l2('tempo', 6)} | previsto/reale`);
  q.items.forEach((it) => {
    const nm = it.key.name.length > w ? it.key.name.slice(0, w - 1) + '…' : it.key.name, r = it.result;
    if (it.status === ST.DONE && r) {
      out.push(`CODA | ${p2(nm, w)} | ${l2(`${fM(r.inMB)} → ${fM(r.outMB)}`, 18)} | ${l2(r.kept ? 'orig.' : fmtPct(r.pct, 0).replace(' %', ''), 5)} | ${l2(fT(r.timeS), 6)} | peso ${fM(r.predMB)}/${fM(r.outMB)} MB · tempo ${fT(r.predS)}/${fT(r.timeS)}`);
    } else {
      out.push(`CODA | ${p2(nm, w)} | ${l2(`${fM(it.key.size / 1048576)} → —`, 18)} | ${l2('', 5)} | ${l2('', 6)} | ${STATUS_LABEL[it.status] || it.status}${it.error ? ': ' + String(it.error).slice(0, 80) : ''}`);
    }
  });
  return out;
}

/** Copia serializzabile (JSON) della coda: niente riferimenti runtime. */
export const serialize = (q) => JSON.parse(JSON.stringify(q));
