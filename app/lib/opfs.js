// OPFS output store: sequential/random writes through a Worker holding a SyncAccessHandle (no RAM accumulation),
// then getFile() gives a disk-backed File for share/download. Also: stale-file cleanup and space estimate.

/** Remove every file left in the OPFS root by previous runs (call at startup / before a new run). */
export async function cleanOpfs() {
  try {
    const root = await navigator.storage.getDirectory(); const names = [];
    for await (const [name] of root.entries()) names.push(name);
    let n = 0; for (const name of names) { try { await root.removeEntry(name); n++; } catch { /* locked by another tab */ } }
    return n;
  } catch { return 0; }
}

export const opfsSupported = () => !!(navigator.storage?.getDirectory && typeof Worker !== 'undefined');

/** {usage, quota, free} in bytes, or null when estimate() is unavailable. */
export async function opfsSpace() {
  try { const e = await navigator.storage.estimate(); if (!e?.quota) return null; return { usage: e.usage || 0, quota: e.quota, free: e.quota - (e.usage || 0) }; } catch { return null; }
}

const safeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');

export async function openOpfsStore(rawName) {
  const name = safeName(rawName);
  const worker = new Worker(new URL('./opfs-worker.js?v=0.16', import.meta.url));
  let seq = 0; const waiting = new Map(); let dead = null; let bytesWritten = 0;
  worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); if (e.data.ok) w.res(e.data); else { const er = new Error(e.data.message); er.name = e.data.name; w.rej(er); } };
  worker.onerror = (e) => { dead = new Error('worker OPFS: ' + (e.message || 'errore')); for (const w of waiting.values()) w.rej(dead); waiting.clear(); };
  const call = (msg, transfer) => dead ? Promise.reject(dead) : new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); worker.postMessage({ id, ...msg }, transfer || []); });
  await call({ op: 'open', name });
  let closed = false;
  return {
    name,
    get bytesWritten() { return bytesWritten; },
    /** Copies (the caller keeps its buffer) and awaits the worker ack. */
    write(pos, u8) { const c = u8.slice(); bytesWritten += c.length; return call({ op: 'write', pos, data: c.buffer }, [c.buffer]); },
    async read(pos, len) { const r = await call({ op: 'read', pos, len }); return new Uint8Array(r.data, 0, r.n); },
    truncate: (size) => call({ op: 'truncate', size }),
    flush: () => call({ op: 'flush' }),
    async size() { return (await call({ op: 'size' })).size; },
    async close() { if (closed) return; closed = true; try { await call({ op: 'close' }); } finally { worker.terminate(); } },
    /** Disk-backed File (store must be closed first). */
    async getFile() { const root = await navigator.storage.getDirectory(); return (await root.getFileHandle(name)).getFile(); },
    async remove() { await this.close().catch(() => {}); try { const root = await navigator.storage.getDirectory(); await root.removeEntry(name); } catch {} },
  };
}
