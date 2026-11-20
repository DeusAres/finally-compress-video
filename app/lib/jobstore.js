// Resumable export job in OPFS ("packet store"). Layout: jobs/current/
//   manifest.json   {v, app, file:{name,size,lastModified}, settings, video:{W,H,nFrames,firstTs,lastTs,keyEvery,dv},
//                    segStarts:[frame index…], doneCount, config:{codec,codedWidth,codedHeight,colorSpace,description(b64 hvcC)}}
//   seg-NNNN.bin    encoded packets of segment N back to back (already stripParameterSets + RPU appended)
//   seg-NNNN.json   {k, n, bytes, rpu, packets:[{ts,dur,type,offset,size}]}  (ts/dur in seconds, output timeline)
// A segment counts as done only when the manifest says so AND its index + binary size agree (verifiedDone).
// Writes go through the SyncAccessHandle worker (opfs-worker.js): no packet is kept in RAM after its write is acked.
import { opfsWorker } from './opfs.js?v=0.26';

export const JOB_VERSION = 1;
const DIR = ['jobs', 'current'];
const pad = (i) => String(i).padStart(4, '0');
const te = new TextEncoder();

export const fileKey = (f) => ({ name: f.name, size: f.size, lastModified: f.lastModified });
export const sameFile = (a, b) => !!(a && b && a.name === b.name && a.size === b.size && a.lastModified === b.lastModified);
/** Only the settings that change the encoded video matter for resuming (audio is processed at assembly). */
export const sameVideoSettings = (a, b) => !!(a && b && +a.bitrateMbps === +b.bitrateMbps && +a.keyframeS === +b.keyframeS);

export const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const bytesEqual = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/**
 * Segment plan: start frame indices. Segments of ~targetS seconds, a multiple of the user keyframe interval when that
 * interval is ≤ maxS (so the user's GOP is kept exactly), otherwise ~targetS (keyframe forced at every segment start).
 */
export function planSegments(nFrames, fps, keyEvery, { targetS = 5, maxS = 6 } = {}) {
  fps = fps > 0 ? fps : 60;
  let len = keyEvery <= maxS * fps ? keyEvery * Math.max(1, Math.round(targetS * fps / keyEvery)) : Math.round(targetS * fps);
  len = Math.max(1, len);
  const starts = []; for (let i = 0; i < nFrames; i += len) starts.push(i);
  // a very short tail (< 1/3 segment) is merged into the previous segment
  if (starts.length > 1 && nFrames - starts[starts.length - 1] < len / 3) starts.pop();
  return starts;
}
export const segEnd = (starts, k, nFrames) => (k + 1 < starts.length ? starts[k + 1] : nFrames);

async function jobDir(create = false) {
  let d = await navigator.storage.getDirectory();
  for (const p of DIR) d = await d.getDirectoryHandle(p, { create });
  return d;
}
async function readJson(dir, name) {
  try { const f = await (await dir.getFileHandle(name)).getFile(); return JSON.parse(await f.text()); } catch { return null; }
}
async function verifiedDone(dir, m) {
  let k = 0, bytes = 0;
  for (; k < Math.min(m.doneCount || 0, m.segStarts.length); k++) {
    const idx = await readJson(dir, `seg-${pad(k)}.json`);
    if (!idx || idx.k !== k || idx.n !== segEnd(m.segStarts, k, m.video.nFrames) - m.segStarts[k]) break;
    try { const f = await (await dir.getFileHandle(`seg-${pad(k)}.bin`)).getFile(); if (f.size !== idx.bytes) break; } catch { break; }
    bytes += idx.bytes;
  }
  return { done: k, bytes };
}

/** Saved job, or null: {manifest, done (verified contiguous segments), total, bytes}. */
export async function peekJob() {
  try {
    const dir = await jobDir(false); const m = await readJson(dir, 'manifest.json');
    if (!m || m.v !== JOB_VERSION || !Array.isArray(m.segStarts)) return null;
    const { done, bytes } = await verifiedDone(dir, m);
    return { manifest: m, done, total: m.segStarts.length, bytes };
  } catch { return null; }
}

/** Delete the saved job (all segments). */
export async function discardJob() {
  for (let i = 0; i < 6; i++) { // a just-terminated worker may still hold its handles for a moment
    try { const root = await navigator.storage.getDirectory(); const j = await root.getDirectoryHandle('jobs'); await j.removeEntry('current', { recursive: true }); return; }
    catch (e) { if (e?.name === 'NotFoundError') return; await new Promise((r) => setTimeout(r, 60)); }
  }
}

/**
 * Open the job store. fresh=true: delete any previous job and write `manifest`; otherwise continue the saved one
 * (manifest = the saved manifest, doneCount trimmed to the verified count).
 */
export async function openJob(manifest, { fresh = false, done = manifest.doneCount || 0 } = {}) {
  if (fresh) await discardJob();
  const wk = opfsWorker(), call = wk.call;
  const writeJson = (name, obj) => { const b = te.encode(JSON.stringify(obj)); return call({ op: 'writeFile', dir: DIR, name, data: b.buffer }, [b.buffer]); };
  manifest.doneCount = fresh ? 0 : done;
  manifest.updated = Date.now();
  await writeJson('manifest.json', manifest);
  const dir = await jobDir(true);
  let closed = false;
  const job = {
    manifest,
    get doneCount() { return manifest.doneCount; },
    get total() { return manifest.segStarts.length; },
    /** Decoder config saved with the job (description = patched hvcC as Uint8Array), or null. */
    getConfig() { const c = manifest.config; return c ? { ...c, description: fromB64(c.description) } : null; },
    async setConfig(c) { manifest.config = { ...c, description: toB64(c.description) }; manifest.updated = Date.now(); await writeJson('manifest.json', manifest); },
    /** Writer for segment k (truncates any partial data). add() resolves when the worker has written the bytes. */
    async beginSegment(k) {
      const h = 'seg' + k, packets = []; let pos = 0, rpu = 0;
      await call({ op: 'open', h, dir: DIR, name: `seg-${pad(k)}.bin` });
      return {
        k,
        get count() { return packets.length; },
        add(u8, { ts, dur, type, hasRpu = false }) {
          const own = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice(); // transfer, no extra copy
          packets.push({ ts, dur, type, offset: pos, size: own.length }); const at = pos; pos += own.length; if (hasRpu) rpu++;
          return call({ op: 'write', h, pos: at, data: own.buffer }, [own.buffer]);
        },
        async finish() {
          await call({ op: 'close', h });
          await writeJson(`seg-${pad(k)}.json`, { k, n: packets.length, bytes: pos, rpu, packets });
          manifest.doneCount = k + 1; manifest.updated = Date.now();
          await writeJson('manifest.json', manifest);
          return { n: packets.length, bytes: pos, rpu };
        },
        abort: () => call({ op: 'close', h }).catch(() => {}),
      };
    },
    readIndex: (k) => readJson(dir, `seg-${pad(k)}.json`),
    /** Stream the packets of segment k: yields {data, ts, dur, type}. Reads the binary in windows of ~windowBytes. */
    async *packets(k, windowBytes = 4 * 1048576) {
      const idx = await readJson(dir, `seg-${pad(k)}.json`); if (!idx) throw new Error(`indice segmento ${k} mancante`);
      const f = await (await dir.getFileHandle(`seg-${pad(k)}.bin`)).getFile();
      if (f.size !== idx.bytes) throw new Error(`segmento ${k}: ${f.size} byte su disco, attesi ${idx.bytes}`);
      let wStart = 0, wEnd = 0, buf = null;
      for (const p of idx.packets) {
        if (p.offset < wStart || p.offset + p.size > wEnd) {
          wStart = p.offset; wEnd = Math.min(idx.bytes, Math.max(p.offset + p.size, p.offset + windowBytes));
          buf = new Uint8Array(await f.slice(wStart, wEnd).arrayBuffer());
        }
        yield { data: buf.subarray(p.offset - wStart, p.offset - wStart + p.size), ts: p.ts, dur: p.dur, type: p.type };
      }
    },
    async removeSegment(k) { for (const n of [`seg-${pad(k)}.bin`, `seg-${pad(k)}.json`]) { try { await dir.removeEntry(n); } catch {} } },
    /** Invalidate the manifest (job no longer resumable, e.g. segments consumed during assembly). */
    async invalidate() { try { await dir.removeEntry('manifest.json'); } catch {} },
    close() { if (!closed) { closed = true; wk.terminate(); } },
    async remove() { job.close(); await discardJob(); },
  };
  return job;
}
