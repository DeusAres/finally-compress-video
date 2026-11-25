// Post-processing of the MP4 produced by Mediabunny (fastStart:false => moov AFTER mdat, so growing/shrinking
// boxes inside moov never moves mdat and chunk offsets (stco/co64) stay valid).
import { parseBoxes, childrenOffset, findBox, boxBytes, videoTrak } from './dovi.js?v=0.35.3';

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
export function rebuild(bytes, fn) {
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

/**
 * Set (replace or add) a UTF-8 string value in moov/meta (QuickTime mdta: hdlr, keys, ilst).
 * Used to tag the output (e.g. com.apple.quicktime.displayname = "IMG_7440 · 8 Mbps").
 * No-op (returns moov unchanged) if there is no moov/meta with keys+ilst.
 */
export function setMetaString(moovBytes, key, value) {
  const meta = findBox(moovBytes, ['moov', 'meta']);
  if (!meta) return moovBytes;
  const te = new TextEncoder(), kb = te.encode(key), vb = te.encode(value);
  const u32 = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  return editAt(moovBytes, ['moov', 'meta'], (metaBytes) => rebuild(metaBytes, (kids) => {
    const keysK = kids.find((k) => k.type === 'keys'), ilstK = kids.find((k) => k.type === 'ilst');
    if (!keysK || !ilstK) return kids;
    // keys: [size type][ver/flags 4][count 4] then entries [size 4]['mdta' 4][key]
    const kbuf = keysK.bytes; const dv = new DataView(kbuf.buffer, kbuf.byteOffset, kbuf.byteLength);
    const count = dv.getUint32(12); let off = 16, idx = 0;
    for (let i = 1; i <= count; i++) { const sz = dv.getUint32(off); const name = new TextDecoder().decode(kbuf.subarray(off + 8, off + sz)); if (name === key) idx = i; off += sz; }
    const dataBox = makeBox('data', u32(1), u32(0), vb); // type 1 = UTF-8, locale 0
    let newKeys = keysK.bytes;
    if (!idx) { idx = count + 1; newKeys = makeBox('keys', kbuf.subarray(8, 12), u32(count + 1), kbuf.subarray(16), u32(8 + kb.length), te.encode('mdta'), kb); }
    const item = (() => { const b = makeBox('xxxx', dataBox); b.set(u32(idx), 4); return b; })(); // ilst item type = 1-based key index
    const ilstItems = parseBoxes(ilstK.bytes, 8, ilstK.bytes.length).filter((b) => new DataView(ilstK.bytes.buffer, ilstK.bytes.byteOffset).getUint32(b.start + 4) !== idx).map((b) => ilstK.bytes.subarray(b.start, b.end));
    const newIlst = makeBox('ilst', ...ilstItems, item);
    return kids.map((k) => (k.type === 'keys' ? { type: 'keys', bytes: newKeys } : k.type === 'ilst' ? { type: 'ilst', bytes: newIlst } : k));
  }));
}

// ---- QuickTime (MOV) alignment, v0.34 ------------------------------------------------------------------------------
const fcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const r32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const kidsOf = (buf, box) => parseBoxes(buf, box.start + childrenOffset(buf, box), box.end);
const kidOf = (buf, box, t) => kidsOf(buf, box).find((b) => b.type === t) || null;
const handlerOf = (buf, trak) => { const md = kidOf(buf, trak, 'mdia'), h = md && kidOf(buf, md, 'hdlr'); return h ? fcc(buf, h.start + h.hdr + 8) : null; };
const entryOf = (buf, trak) => {
  const md = kidOf(buf, trak, 'mdia'), mi = md && kidOf(buf, md, 'minf'), st = mi && kidOf(buf, mi, 'stbl'), sd = st && kidOf(buf, st, 'stsd');
  return sd ? { stsd: sd, entry: parseBoxes(buf, sd.start + sd.hdr + 8, sd.end)[0] || null } : null;
};
/** Video trak and AAC trak (the fallback of apac when present, else the first mp4a) of a moov. */
function avTraks(moov) {
  const traks = kidsOf(moov, parseBoxes(moov)[0]).filter((b) => b.type === 'trak');
  const video = traks.find((t) => handlerOf(moov, t) === 'vide') || null;
  const aacs = traks.filter((t) => handlerOf(moov, t) === 'soun' && entryOf(moov, t)?.entry?.type === 'mp4a');
  const apac = traks.find((t) => entryOf(moov, t)?.entry?.type === 'apac');
  let aac = aacs[0] || null;
  if (apac && aacs.length > 1) {
    const tref = kidOf(moov, apac, 'tref'), fall = tref && kidOf(moov, tref, 'fall');
    const id = fall ? r32(moov, fall.start + fall.hdr) : 0;
    aac = aacs.find((t) => { const tk = kidOf(moov, t, 'tkhd'), p = tk.start + tk.hdr; return r32(moov, p + (moov[p] === 1 ? 20 : 12)) === id; }) || aac;
  }
  return { video, aac };
}
// editAt predicate selecting the trak that starts at trak.start in moov (editAt passes each child as its own buffer, so count)
const sel = (moov, trak) => { const n = kidsOf(moov, parseBoxes(moov)[0]).filter((b) => b.type === 'trak').findIndex((b) => b.start === trak.start); let i = -1; return { type: 'trak', pred: () => ++i === n }; };

/**
 * Make the video/AAC traks of a Mediabunny MOV look like the iPhone ones (src = source .mov moov), for the parts
 * QuickTime/AVFoundation cares about (research/04 «Contenitore MOV»):
 *  - mdia/hdlr: source 'mhlr' handler verbatim (manufacturer 'appl', Pascal name «Core Media Video/Audio»);
 *  - minf: media header kept, source data handler 'dhlr'/'alis' + dinf (alis self reference) verbatim, stbl kept;
 *  - video tkhd flags as in the source (0xf: enabled, in movie, in preview, in poster) + 'tapt' (clef/prof/enof =
 *    output tkhd dimensions) right after tkhd, as iPhone files;
 *  - hvc1: temporal/spatial quality + compressor name («HEVC») from the source, children in the source order
 *    (hvcC, dvvC, colr, amve...): 'amve'/'pasp'/'fiel' copied from the source when the output has none, 'btrt' dropped;
 *  - AAC stsd: audioCopied (packets = source packets) -> source stsd verbatim (SoundDescription v1 with wave/frma/esds);
 *    otherwise the source stsd with the esds inside 'wave' replaced by Mediabunny's esds (same rate/channels).
 * Any part that cannot be matched (missing source trak, unexpected structure) is left as written by Mediabunny.
 * Returns {moov, changes:[strings]}.
 */
export function alignToQuickTime(srcMoov, outMoov, { audioCopied = false } = {}) {
  assertMoov(srcMoov); assertMoov(outMoov);
  const changes = [];
  const S = avTraks(srcMoov);
  let moov = outMoov;
  for (const kind of ['video', 'aac']) {
    const st = S[kind]; if (!st) continue;
    const ot = avTraks(moov)[kind]; if (!ot) continue;
    const sMdia = kidOf(srcMoov, st, 'mdia'), sMinf = sMdia && kidOf(srcMoov, sMdia, 'minf');
    if (!sMdia || !sMinf) continue;
    const sHdlr = kidOf(srcMoov, sMdia, 'hdlr'), sDhlr = kidOf(srcMoov, sMinf, 'hdlr'), sDinf = kidOf(srcMoov, sMinf, 'dinf');
    const sEnt = entryOf(srcMoov, st);
    const sb = (b) => ({ type: b.type, bytes: boxBytes(srcMoov, b) });
    // mdia extras of the source (e.g. 'elng' extended language), placed after mdhd as in the source
    const sExtra = kidsOf(srcMoov, sMdia).filter((b) => !['mdhd', 'hdlr', 'minf'].includes(b.type)).map(sb);
    const fixVideoEntry = (eb) => {
      const se = sEnt.entry, sbuf = srcMoov.subarray(se.start, se.end), b0 = eb.slice();
      b0.set(sbuf.subarray(se.hdr + 16, se.hdr + 24), 8 + 16); // temporal + spatial quality
      b0.set(sbuf.subarray(se.hdr + 42, se.hdr + 74), 8 + 42); // compressor name (32 bytes, Pascal string)
      const srcKids = parseBoxes(sbuf, se.hdr + 78, sbuf.length);
      return rebuild(b0, (kids) => {
        const have = new Map(kids.map((k) => [k.type, k])), res = [];
        for (const x of srcKids) {
          if (have.has(x.type)) { res.push(have.get(x.type)); have.delete(x.type); }
          else if (['amve', 'pasp', 'fiel'].includes(x.type)) res.push({ type: x.type, bytes: boxBytes(sbuf, x) });
        }
        for (const [t, k] of have) if (t !== 'btrt') res.push(k);
        return res;
      });
    };
    const fixStsd = (x) => {
      if (!sEnt?.entry) return x;
      if (kind === 'aac') {
        if (sEnt.entry.type !== 'mp4a') return x;
        const srcStsd = boxBytes(srcMoov, sEnt.stsd);
        return { type: 'stsd', bytes: audioCopied ? srcStsd : (withEsds(srcStsd, x.bytes) || x.bytes) };
      }
      const vid = (t) => ['hvc1', 'hev1'].includes(t);
      return { type: 'stsd', bytes: rebuild(x.bytes, (ents) => ents.map((e, i) => (i === 0 && vid(e.type) && vid(sEnt.entry.type) ? { type: e.type, bytes: fixVideoEntry(e.bytes) } : e))) };
    };
    const fixMinf = (mb) => rebuild(mb, (nk) => {
      const isHead = (t) => ['vmhd', 'smhd', 'gmhd', 'nmhd'].includes(t);
      const head = nk.filter((x) => isHead(x.type));
      const rest = nk.filter((x) => !isHead(x.type) && !['stbl', 'hdlr', 'dinf'].includes(x.type));
      const dinf = sDinf ? [sb(sDinf)] : nk.filter((x) => x.type === 'dinf');
      const stbl = nk.filter((x) => x.type === 'stbl').map((x) => ({ type: 'stbl', bytes: rebuild(x.bytes, (sk) => sk.map((y) => (y.type === 'stsd' ? fixStsd(y) : y))) }));
      return [...head, ...(sDhlr ? [sb(sDhlr)] : nk.filter((x) => x.type === 'hdlr')), ...dinf, ...rest, ...stbl];
    });
    const fixMdia = (mb) => rebuild(mb, (mk0) => {
      const mk = mk0.filter((m) => !sExtra.some((x) => x.type === m.type)).map((m) => (m.type === 'hdlr' && sHdlr ? sb(sHdlr) : m.type === 'minf' ? { type: 'minf', bytes: fixMinf(m.bytes) } : m));
      mk.splice(mk.findIndex((m) => m.type === 'mdhd') + 1, 0, ...sExtra);
      return mk;
    });
    moov = editAt(moov, ['moov', sel(moov, ot)], (trak) => rebuild(trak, (kids) => {
      let out = kids.map((k) => {
        if (k.type === 'tkhd' && kind === 'video') {
          const b = k.bytes.slice(), tk = kidOf(srcMoov, st, 'tkhd');
          b.set(srcMoov.subarray(tk.start + tk.hdr + 1, tk.start + tk.hdr + 4), 9); // flags
          return { type: 'tkhd', bytes: b };
        }
        return k.type === 'mdia' ? { type: 'mdia', bytes: fixMdia(k.bytes) } : k;
      });
      if (kind === 'video' && kidOf(srcMoov, st, 'tapt')) { // tapt: clean/production/encoded aperture = output tkhd width/height
        const tk = out.find((k) => k.type === 'tkhd');
        const wh = tk.bytes.subarray(tk.bytes.length - 8), dim = (t) => makeBox(t, new Uint8Array(4), wh);
        out = out.filter((k) => k.type !== 'tapt');
        out.splice(out.indexOf(tk) + 1, 0, { type: 'tapt', bytes: makeBox('tapt', dim('clef'), dim('prof'), dim('enof')) });
      }
      return out;
    }));
    changes.push(kind === 'video' ? 'video: tkhd flags, tapt, hdlr mhlr/dhlr, dinf alis, hvc1 (nome «HEVC», ordine hvcC/dvvC/colr/amve)' : `AAC: hdlr mhlr/dhlr, dinf alis${sExtra.length ? ', ' + sExtra.map((x) => x.type).join('/') : ''}, stsd ${audioCopied ? 'della sorgente' : 'della sorgente con esds nuovo'}`);
  }
  return { moov, changes };
}

/** srcStsd (mp4a v1 with wave{frma, mp4a, esds, ...}) with its esds replaced by the first esds found in outStsd; null if not applicable. */
function withEsds(srcStsd, outStsd) {
  const esdsIn = (buf) => { const i = (() => { for (let o = 16; o + 8 <= buf.length; o++) if (buf[o] === 0x65 && fcc(buf, o) === 'esds') return o - 4; return -1; })(); return i < 0 ? null : buf.subarray(i, i + r32(buf, i)); };
  const newEsds = esdsIn(outStsd); if (!newEsds) return null;
  const s = parseBoxes(srcStsd)[0], ent = parseBoxes(srcStsd, s.start + s.hdr + 8, s.end)[0];
  if (!ent || ent.type !== 'mp4a') return null;
  const ver = (srcStsd[ent.start + ent.hdr + 8] << 8) | srcStsd[ent.start + ent.hdr + 9];
  const pre = ent.hdr + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
  const eb = srcStsd.subarray(ent.start, ent.end);
  const kids = parseBoxes(eb, pre, eb.length);
  let done = false;
  const newKids = kids.map((k) => {
    const kb = boxBytes(eb, k);
    if (k.type === 'esds') { done = true; return newEsds; }
    if (k.type !== 'wave') return kb;
    const wk = parseBoxes(kb, 8, kb.length).map((w) => (w.type === 'esds' ? (done = true, newEsds) : boxBytes(kb, w)));
    return makeBox('wave', ...wk);
  });
  if (!done) return null;
  return makeBox('stsd', srcStsd.subarray(s.hdr, s.hdr + 8), makeBox('mp4a', eb.subarray(ent.hdr, pre), ...newKids));
}

/**
 * ftyp of a QuickTime output aligned to the source: returns the source ftyp bytes when the output ftyp has the same size
 * (patched in place at offset 0, nothing moves), else null. Both are Uint8Array starting with an ftyp box.
 */
export function sourceFtypPatch(srcHead, outHead) {
  const s = parseBoxes(srcHead)[0], o = parseBoxes(outHead)[0];
  if (!s || !o || s.type !== 'ftyp' || o.type !== 'ftyp' || s.end !== o.end) return null;
  return srcHead.slice(0, s.end);
}

/**
 * The whole final-moov edit of the app (index.html) in one place, also used by the tests:
 * source metadata (moov/meta + video trak meta) -> dvcC/dvvC in hvc1 -> UTF-8 strings in moov/meta ->
 * (quickTime) alignToQuickTime. Returns {moov, changes}.
 */
export function finishMoov(srcMoov, moov, { dvBox = null, strings = {}, quickTime = false, audioCopied = false } = {}) {
  let x = srcMoov ? copySourceMetadata(srcMoov, moov) : moov;
  if (dvBox) x = insertIntoVideoSampleEntry(x, dvBox);
  for (const [k, v] of Object.entries(strings)) x = setMetaString(x, k, v);
  let changes = [];
  if (quickTime && srcMoov) ({ moov: x, changes } = alignToQuickTime(srcMoov, x, { audioCopied }));
  return { moov: x, changes };
}
