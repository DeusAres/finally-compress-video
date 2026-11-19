// Bus eventi UI ↔ app. Contratto in app/ui/README.md.
// L'app (index.html) emette, la UI (ui.js) e l'intrattenimento (fun.js) ascoltano.
export const bus = new EventTarget();

/** Emette un CustomEvent sul bus. */
export function emit(type, detail = {}) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

/** Estensione: ascolta un evento e ricevi direttamente `detail`. Ritorna la funzione per smettere di ascoltare. */
export function on(type, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

/** Elenco dei tipi di evento ufficiali (utile per debug/preview). */
export const EVENTS = Object.freeze(['file', 'phase', 'progress', 'frame', 'result', 'log', 'error']);
export const PHASES = Object.freeze(['analisi', 'video', 'audio', 'scrittura', 'fatto', 'errore']);
