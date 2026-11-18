// Post-processing of the MP4 produced by Mediabunny (fastStart:false => moov AFTER mdat, so growing/shrinking
// boxes inside moov never moves mdat and chunk offsets (stco/co64) stay valid).
import { parseBoxes, childrenOffset, findBox, boxBytes, videoTrak } from './dovi.js?v=0.8';

const fourccBytes = (s) => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** Make a box from type + payload parts (32-bit size). */
export function makeBox(type, ...parts) {
  const payload = concat(parts);
  const out = new Uint8Array(8 + payload.length);
  const n = out.length;
  out.set([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...fourccBytes(type)], 0);
  out.set(payload, 8);
  return out;
}

// Rebuild a container box: fn([{type,bytes}]) -> new children ({type,bytes}); header prefix (e.g. stsd entry
// count, sample-entry fields) is kept, size recomputed (32-bit header).
function rebuild(bytes, fn) {
  const box = parseBoxes(bytes)[0];
  const cOff = box.start + childrenOffset(bytes, box);
  const kids = parseBoxes(bytes, cOff, box.end);
  const end = kids.length ? kids[kids.length - 1].end : cOff;
  const newKids = fn(kids.map((b) => ({ type: b.type, bytes: boxBytes(bytes, b) }))).map((k) => k.bytes);
  return makeBox(box.type, bytes.subarray(box.hdr, cOff), ...newKids, bytes.subarray(end, box.end));
}

/** Apply fn(boxBytes)->boxBytes to the first box at `path` (path[0] is the root itself), rebuilding ancestors. */
function editAt(bytes, path, fn) {
  if (path.length === 1) return fn(bytes);
  const el = path[1];
  let done = false;
  return rebuild(bytes, (kids) => kids.map((k) => {
    if (done) return k;
    const kb = parseBoxes(k.bytes)[0];
    const ok = typeof el === 'string' ? k.type === el : k.type === el.type && (!el.pred || el.pred(k.bytes, kb));
    if (!ok) return k;
    done = true;
    return { type: k.type, bytes: editAt(k.bytes, path.slice(1), fn) };
  }));
}

function assertMoov(moov) {
  const r = parseBoxes(moov)[0];
  if (!r || r.type !== 'moov' || r.end !== moov.length) throw new Error('moovBytes must be exactly one moov box');
  return r;
}

/**
 * Insert a dvcC/dvvC box into the video sample entry (hvc1/hev1), right after hvcC (as in iPhone files:
 * hvcC, dvvC, colr, amve). Existing dvcC/dvvC are replaced. Sizes of hvc1/stsd/stbl/minf/mdia/trak/moov updated.
 */
export function insertIntoVideoSampleEntry(moovBytes, boxBytesDv) {
  assertMoov(moovBytes);
  const dvType = String.fromCharCode(...boxBytesDv.subarray(4, 8));
  if (dvType !== 'dvcC' && dvType !== 'dvvC') throw new Error('not a dvcC/dvvC box');
  return editAt(moovBytes, ['moov', videoTrak, 'mdia', 'minf', 'stbl', 'stsd'], (stsd) =>
    rebuild(stsd, (entries) => {
      let done = false;
      return entries.map((e) => {
        if (done || !['hvc1', 'hev1'].includes(e.type)) return e;
        done = true;
        return { type: e.type, bytes: rebuild(e.bytes, (kids) => {
          const k2 = kids.filter((k) => k.type !== 'dvcC' && k.type !== 'dvvC');
          const i = k2.findIndex((k) => k.type === 'hvcC');
          k2.splice(i + 1, 0, { type: dvType, bytes: boxBytesDv });
          return k2;
        }) };
      });
    }));
}

/** Strip the 4-byte version/flags of an ISO `meta` box, giving the QuickTime layout used by iPhone files. */
function metaToQuickTime(meta) {
  const b = parseBoxes(meta)[0];
  if (childrenOffset(meta, b) === b.hdr) return meta;
  return makeBox('meta', meta.subarray(b.hdr + 4));
}

/**
 * Move moov/udta/meta (hdlr mdta + keys + ilst) to moov/meta (QuickTime layout, as iPhone files);
 * udta is removed when it becomes empty.
 */
export function moveUdtaMetaToMoov(moovBytes) {
  assertMoov(moovBytes);
  let moved = null;
  const out = rebuild(moovBytes, (kids) => {
    const res = [];
    for (const k of kids) {
      if (k.type !== 'udta') { res.push(k); continue; }
      const ub = parseBoxes(k.bytes)[0];
      const rest = [];
      for (const c of parseBoxes(k.bytes, ub.start + ub.hdr, ub.end)) {
        if (c.type === 'meta' && !moved) moved = metaToQuickTime(boxBytes(k.bytes, c));
        else rest.push(boxBytes(k.bytes, c));
      }
      if (rest.length) res.push({ type: 'udta', bytes: makeBox('udta', ...rest) });
    }
    const filtered = res.filter((k) => !(k.type === 'meta' && moved));
    if (moved) filtered.push({ type: 'meta', bytes: moved });
    return filtered;
  });
  return out;
}

/**
 * Copy VERBATIM from the source .mov: (a) moov/meta (keys+ilst: creationdate, make, model, ...) and
 * (b) the video trak's own meta (camera lens/focal length...), replacing whatever the muxer wrote
 * (moov/udta/meta of Mediabunny is removed; udta dropped if empty). srcMoov/outMoov are moov boxes.
 * Missing source boxes are simply not copied.
 */
export function copySourceMetadata(srcMoov, outMoov) {
  assertMoov(srcMoov); assertMoov(outMoov);
  const srcMeta = findBox(srcMoov, ['moov', 'meta']);
  const srcTrakMeta = findBox(srcMoov, ['moov', videoTrak, 'meta']);
  const srcMetaBytes = srcMeta ? boxBytes(srcMoov, srcMeta) : null;
  const srcTrakMetaBytes = srcTrakMeta ? boxBytes(srcMoov, srcTrakMeta) : null;
  let out = rebuild(outMoov, (kids) => {
    const res = [];
    for (const k of kids) {
      if (srcMetaBytes && k.type === 'meta') continue; // replaced
      if (k.type === 'udta') {
        const ub = parseBoxes(k.bytes)[0];
        const rest = parseBoxes(k.bytes, ub.start + ub.hdr, ub.end).filter((c) => !(srcMetaBytes && c.type === 'meta')).map((c) => boxBytes(k.bytes, c));
        if (rest.length) res.push({ type: 'udta', bytes: makeBox('udta', ...rest) });
        continue;
      }
      res.push(k);
    }
    if (srcMetaBytes) res.push({ type: 'meta', bytes: srcMetaBytes });
    return res;
  });
  if (srcTrakMetaBytes) {
    out = editAt(out, ['moov', videoTrak], (trak) =>
      rebuild(trak, (kids) => [...kids.filter((k) => k.type !== 'meta'), { type: 'meta', bytes: srcTrakMetaBytes }]));
  }
  return out;
}

/**
 * Replace the final moov of an MP4. src = Uint8Array (whole file) or {size, read(offset,len)->Promise<Uint8Array>}.
 * fn(moovBytes) -> new moovBytes. Throws unless moov comes after mdat (offsets would shift otherwise).
 * Returns {prefixLength, moov}; browser: new Blob([blob.slice(0, prefixLength), moov], {type:'video/mp4'}).
 */
export async function rewriteMoov(src, fn) {
  const read = src instanceof Uint8Array ? async (o, l) => src.subarray(o, o + l) : src.read;
  const size = src instanceof Uint8Array ? src.length : src.size;
  let off = 0, mdatSeen = false, moov = null;
  while (off + 8 <= size) {
    const h = await read(off, 16);
    let sz = (h[0] * 16777216) + ((h[1] << 16) | (h[2] << 8) | h[3]);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (sz === 1) sz = new DataView(h.buffer, h.byteOffset).getUint32(8) * 4294967296 + new DataView(h.buffer, h.byteOffset).getUint32(12);
    else if (sz === 0) sz = size - off;
    if (sz < 8) throw new Error('corrupt box at ' + off);
    if (type === 'mdat') mdatSeen = true;
    if (type === 'moov') { moov = { offset: off, size: sz }; if (!mdatSeen) throw new Error('moov precedes mdat: refusing to rewrite (chunk offsets would shift)'); }
    off += sz;
  }
  if (!moov) throw new Error('no moov');
  if (moov.offset + moov.size !== size) throw new Error('moov is not the last box');
  const newMoov = fn(await read(moov.offset, moov.size));
  return { prefixLength: moov.offset, moov: newMoov };
}
