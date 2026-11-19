// OPFS writer worker (classic worker, no imports). Owns ONE FileSystemSyncAccessHandle (Safari: only available in Workers;
// createWritable is not reliable on WebKit, research/03 §4). Protocol: {id, op, ...} -> {id, ok, ...} | {id, ok:false, name, message}.
// Writes are sequential (main thread awaits every ack = backpressure); data arrives as a transferred ArrayBuffer.
let ah = null;
const reply = (id, extra, transfer) => postMessage({ id, ok: true, ...extra }, transfer || []);
onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.op) {
      case 'open': {
        const dir = await navigator.storage.getDirectory();
        const fh = await dir.getFileHandle(m.name, { create: true });
        ah = await fh.createSyncAccessHandle();
        ah.truncate(0);
        return reply(m.id, {});
      }
      case 'write': {
        const u8 = new Uint8Array(m.data); let off = 0;
        while (off < u8.length) { const n = ah.write(u8.subarray(off), { at: m.pos + off }); if (!n) throw new Error('scrittura OPFS: 0 byte scritti'); off += n; }
        return reply(m.id, {});
      }
      case 'read': {
        const buf = new Uint8Array(m.len); const n = ah.read(buf, { at: m.pos });
        return reply(m.id, { data: buf.buffer, n }, [buf.buffer]);
      }
      case 'truncate': ah.truncate(m.size); return reply(m.id, {});
      case 'flush': ah.flush(); return reply(m.id, {});
      case 'size': return reply(m.id, { size: ah.getSize() });
      case 'close': if (ah) { try { ah.flush(); } catch {} ah.close(); ah = null; } return reply(m.id, {});
    }
    throw new Error('op sconosciuta ' + m.op);
  } catch (err) { postMessage({ id: m.id, ok: false, name: err?.name || 'Error', message: err?.message || String(err) }); }
};
