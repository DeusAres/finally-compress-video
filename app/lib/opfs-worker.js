// OPFS writer worker (classic worker, no imports). Owns FileSystemSyncAccessHandles (Safari: only available in Workers;
// createWritable is not reliable on WebKit, research/03 §4). Protocol: {id, op, h?, ...} -> {id, ok, ...} | {id, ok:false, name, message}.
// Several files can be open at once (h = handle key, default 0); `dir` = path array below the OPFS root (created on demand).
// Writes are sequential (main thread awaits every ack = backpressure); data arrives as a transferred ArrayBuffer.
const hs = new Map();
const reply = (id, extra, transfer) => postMessage({ id, ok: true, ...extra }, transfer || []);
async function dirOf(path) {
  let d = await navigator.storage.getDirectory();
  for (const p of path || []) d = await d.getDirectoryHandle(p, { create: true });
  return d;
}
const H = (m) => { const ah = hs.get(m.h ?? 0); if (!ah) throw new Error('file OPFS non aperto'); return ah; };
function writeAll(ah, u8, pos) {
  let off = 0;
  while (off < u8.length) { const n = ah.write(u8.subarray(off), { at: pos + off }); if (!n) throw new Error('scrittura OPFS: 0 byte scritti'); off += n; }
}
onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.op) {
      case 'open': {
        const k = m.h ?? 0; if (hs.has(k)) { try { hs.get(k).close(); } catch {} hs.delete(k); }
        const fh = await (await dirOf(m.dir)).getFileHandle(m.name, { create: true });
        const ah = await fh.createSyncAccessHandle();
        if (!m.keep) ah.truncate(0);
        hs.set(k, ah);
        return reply(m.id, { size: ah.getSize() });
      }
      case 'write': writeAll(H(m), new Uint8Array(m.data), m.pos); return reply(m.id, {});
      case 'read': {
        const buf = new Uint8Array(m.len); const n = H(m).read(buf, { at: m.pos });
        return reply(m.id, { data: buf.buffer, n }, [buf.buffer]);
      }
      case 'truncate': H(m).truncate(m.size); return reply(m.id, {});
      case 'flush': H(m).flush(); return reply(m.id, {});
      case 'size': return reply(m.id, { size: H(m).getSize() });
      case 'close': { const k = m.h ?? 0, ah = hs.get(k); if (ah) { try { ah.flush(); } catch {} ah.close(); hs.delete(k); } return reply(m.id, {}); }
      case 'writeFile': { // whole small file (JSON, config): create/truncate, write, flush, close
        const fh = await (await dirOf(m.dir)).getFileHandle(m.name, { create: true });
        const ah = await fh.createSyncAccessHandle();
        try { ah.truncate(0); writeAll(ah, new Uint8Array(m.data), 0); ah.flush(); } finally { ah.close(); }
        return reply(m.id, {});
      }
    }
    throw new Error('op sconosciuta ' + m.op);
  } catch (err) { postMessage({ id: m.id, ok: false, name: err?.name || 'Error', message: err?.message || String(err) }); }
};
