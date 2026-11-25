// Passthrough of the iPhone tracks Mediabunny cannot write (research/04 §1.2, «Passthrough tracce iPhone»):
//  - 'apac' (Apple Positional Audio, spatial audio) and
//  - every 'mebx' timed-metadata track (video-orientation, cinematic-audio, detected-face, live-photo-info,
//    scene-illuminance, segment-identifier, ...). Foto offers «Mix audio» only when the 'cinematic-audio' mebx track
//    (tref cdsc -> apac) is present next to the apac track.
// Samples are copied BYTE FOR BYTE from the source into ONE second 'mdat' after Mediabunny's mdat (chunks in source-file
// order, streamed in blocks: nothing accumulated in RAM). Each track gets a new 'trak': tkhd/edts/mdia from the source
// (mdhd, hdlr, elng, minf media header + data handler verbatim), stbl with stsd + sample tables verbatim and a new
// stco/co64, new track_ID, tref entries REMAPPED (source video -> output video, source AAC -> output AAC, copied track ->
// its new ID), extra trak children (udta, meta, ...) verbatim. Pure ES2020, no deps; Safari and Node.
//
// Output layout: [ftyp][mdat Mediabunny][mdat passthrough][moov + copied traks]
import { parseBoxes, childBoxes, boxBytes, trakHandler } from './dovi.js?v=0.35.5';
import { makeBox, rebuild } from './mp4-post.js?v=0.35.5';
import { trakSampleEntry, kid, tkhdInfo, TK, mvhdInfo, mdhdInfo, readElst, makeElst, shiftEdits, sampleLayout, copyApacData } from './apac.js?v=0.35.5';

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const put32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const put64 = (b, o, v) => { const hi = Math.floor(v / 4294967296); put32(b, o, hi >>> 0); put32(b, o + 4, (v - hi * 4294967296) >>> 0); };
const be32 = (v) => { const b = new Uint8Array(4); put32(b, 0, v >>> 0); return b; };
const be64 = (v) => { const b = new Uint8Array(8); put64(b, 0, v); return b; };
const latin1 = (b, s, e) => { let r = ''; for (let i = s; i < e; i++) r += String.fromCharCode(b[i]); return r; };
const utf8 = (b, s, e) => { try { return new TextDecoder().decode(b.subarray(s, e)); } catch { return latin1(b, s, e); } };
const U32MAX = 4294967295;

/** tref of a trak as [{type, ids:[...]}] (empty if none). */
export function readTref(buf, trak) {
  const tref = kid(buf, trak, 'tref'); if (!tref) return [];
  return childBoxes(buf, tref).map((r) => ({ type: r.type, ids: Array.from({ length: Math.floor((r.end - r.start - r.hdr) / 4) }, (_, i) => u32(buf, r.start + r.hdr + 4 * i)) }));
}
/** Metadata keys declared by a 'mebx' sample entry (stsd/mebx/keys/<local id>/keyd), e.g. ['com.apple.quicktime.video-orientation']. */
export function mebxKeys(buf, stsdBox) {
  const out = [];
  for (const e of parseBoxes(buf, stsdBox.start + stsdBox.hdr + 8, stsdBox.end)) {
    if (e.type !== 'mebx') continue;
    const keys = parseBoxes(buf, e.start + 16, e.end).find((b) => b.type === 'keys'); if (!keys) continue;
    for (const k of parseBoxes(buf, keys.start + keys.hdr, keys.end)) {
      const keyd = parseBoxes(buf, k.start + k.hdr, k.end).find((b) => b.type === 'keyd');
      if (keyd && keyd.end - keyd.start > keyd.hdr + 4) out.push(utf8(buf, keyd.start + keyd.hdr + 4, keyd.end));
    }
  }
  return out;
}
/** Short label of a metadata key set: 'com.apple.quicktime.cinematic-audio' -> 'cinematic-audio'. */
const shortKey = (k) => k.replace(/^(mdta\/)?com\.apple\.quicktime\./, '');

/** Everything needed to copy one trak verbatim (bytes of its boxes + sample/chunk layout in the source file). */
function readCopyTrak(src, trak, movieTimescale) {
  const tk = kid(src, trak, 'tkhd'), mdia = kid(src, trak, 'mdia');
  const minf = mdia && kid(src, mdia, 'minf'), stbl = minf && kid(src, minf, 'stbl'), mdhd = mdia && kid(src, mdia, 'mdhd');
  const sk = stbl ? childBoxes(src, stbl) : [], get = (t) => sk.find((b) => b.type === t) || null;
  const stsd = get('stsd'), stsz = get('stsz'), stsc = get('stsc'), stco = get('stco') || get('co64');
  const entry = trakSampleEntry(src, trak) || '?';
  if (!tk || !mdhd || !stsd || !stsz || !stsc || !stco || !get('stts')) throw new Error(`${entry}: tabelle campioni incomplete` + (get('stz2') ? ' (stz2 non supportato)' : ''));
  const tkhd = tkhdInfo(src, tk), handler = trakHandler(src, trak);
  const layout = sampleLayout(src, stsz, stsc, stco, entry);
  const keys = entry === 'mebx' ? mebxKeys(src, stsd) : [];
  return {
    trackId: tkhd.trackId, handler, entry, keys, label: entry === 'mebx' ? ([...new Set(keys.map((k) => shortKey(k).split('.')[0]))].join('+') || 'mebx') : entry,
    tkhd, mdhd: mdhdInfo(src, mdhd), movieTimescale, edits: readElst(src, kid(src, trak, 'edts')), tref: readTref(src, trak),
    bytes: {
      tkhd: boxBytes(src, tk).slice(),
      mdia: childBoxes(src, mdia).map((b) => ({ type: b.type, bytes: b.type === 'minf' ? null : boxBytes(src, b).slice() })),
      minf: childBoxes(src, minf).map((b) => ({ type: b.type, bytes: b.type === 'stbl' ? null : boxBytes(src, b).slice() })),
      stbl: sk.filter((b) => b.type !== 'stco' && b.type !== 'co64').map((b) => ({ type: b.type, bytes: boxBytes(src, b).slice() })),
      extra: childBoxes(src, trak).filter((b) => !['tkhd', 'edts', 'tref', 'mdia'].includes(b.type)).map((b) => ({ type: b.type, bytes: boxBytes(src, b).slice() })),
    },
    ...layout,
  };
}

/**
 * Scan a source moov. Returns {video:{trackId, flags}|null, aac:{trackId, flags, alternateGroup}|null,
 *  apac: track|null, meta: [track...] (every mebx trak, source order), errors:[{trackId, entry, message}],
 *  order:[track_ID of every source trak, in moov order], nextTrackId (source mvhd)}.
 * A track = readCopyTrak() result: {trackId, handler, entry, keys, label, tkhd, mdhd, edits, tref, bytes, chunks, totalBytes, ...}.
 * Never throws for a single unreadable trak: it goes to `errors` and is not copied.
 */
export function readPassthrough(srcMoov) {
  const root = parseBoxes(srcMoov)[0];
  if (!root || root.type !== 'moov') return null;
  const top = childBoxes(srcMoov, root), mvhd = top.find((b) => b.type === 'mvhd');
  if (!mvhd) return null;
  const movieTs = mvhdInfo(srcMoov, mvhd).timescale, traks = top.filter((b) => b.type === 'trak');
  const mvI = mvhdInfo(srcMoov, mvhd);
  const res = { video: null, aac: null, apac: null, meta: [], errors: [], order: traks.map((t) => tkhdInfo(srcMoov, kid(srcMoov, t, 'tkhd')).trackId), nextTrackId: mvI.nextTrackId };
  const vt = traks.find((t) => trakHandler(srcMoov, t) === 'vide');
  if (vt) { const i = tkhdInfo(srcMoov, kid(srcMoov, vt, 'tkhd')); res.video = { trackId: i.trackId, flags: i.flags }; }
  const take = (t) => { try { return readCopyTrak(srcMoov, t, movieTs); } catch (e) { res.errors.push({ trackId: tkhdInfo(srcMoov, kid(srcMoov, t, 'tkhd')).trackId, entry: trakSampleEntry(srcMoov, t), message: e?.message || String(e) }); return null; } };
  // apac: any trak whose first sample entry is 'apac' (handler 'soun' on iPhone; order apac/AAC varies between files)
  const at = traks.find((t) => trakSampleEntry(srcMoov, t) === 'apac');
  if (at) res.apac = take(at);
  // source AAC: the one apac falls back to (tref 'fall'), else the first mp4a
  const aacT = traks.filter((t) => trakHandler(srcMoov, t) === 'soun' && trakSampleEntry(srcMoov, t) === 'mp4a');
  const fall = res.apac?.tref.find((r) => r.type === 'fall')?.ids[0] || 0;
  const aac = aacT.find((t) => tkhdInfo(srcMoov, kid(srcMoov, t, 'tkhd')).trackId === fall) || aacT[0];
  if (aac) { const i = tkhdInfo(srcMoov, kid(srcMoov, aac, 'tkhd')); res.aac = { trackId: i.trackId, flags: i.flags, alternateGroup: i.alternateGroup }; }
  for (const t of traks) if (trakSampleEntry(srcMoov, t) === 'mebx') { const x = take(t); if (x) res.meta.push(x); }
  return res;
}

/**
 * Decide which source tracks to copy. apac: copy the spatial audio (caller: only if the output AAC is the source AAC copied);
 * meta: copy mebx tracks; aacOut: the output has an AAC track. A track is kept only if every tref target exists in the
 * output (video, AAC if aacOut, or another kept track): e.g. 'cinematic-audio' (cdsc -> apac) is skipped without apac.
 * Returns {tracks:[...] (source order), skipped:[{track, reason}]}.
 */
export function selectPassthrough(info, { apac = true, meta = true, aacOut = true } = {}) {
  const skipped = [];
  let cand = [];
  if (info?.apac) { if (apac) cand.push(info.apac); else skipped.push({ track: info.apac, reason: 'audio spaziale escluso' }); }
  for (const m of info?.meta || []) { if (meta) cand.push(m); else skipped.push({ track: m, reason: 'metadati esclusi' }); }
  const avail = (id, set) => (info.video && id === info.video.trackId) || (aacOut && info.aac && id === info.aac.trackId) || set.some((t) => t.trackId === id);
  for (let changed = true; changed;) { // fixpoint: a track can depend on another copied track (cinematic-audio -> apac)
    changed = false;
    for (const t of cand) {
      const miss = t.tref.flatMap((r) => r.ids.filter((id) => !avail(id, cand)).map((id) => `${r.type}→${id}`));
      // apac's 'fall' (fallback AAC) is optional: missing AAC was already handled by the caller
      const hard = t.entry === 'apac' ? miss.filter((m) => !m.startsWith('fall')) : miss;
      if (hard.length) { cand = cand.filter((x) => x !== t); skipped.push({ track: t, reason: `riferisce tracce assenti in uscita (${hard.join(', ')})` }); changed = true; break; }
    }
  }
  cand.sort((a, b) => a.trackId - b.trackId);
  return { tracks: cand, skipped };
}

/**
 * Layout of ONE mdat with the chunks of all tracks, placed in source-file order (sequential reads) at `pos`.
 * Returns {header, size, dataStart, chunkOffsets:[[...] per track], co64, totalBytes, source:{chunks, totalBytes}}
 * where `source` is the merged chunk list to pass to copyPassthroughData.
 */
export function planPassthroughMdat(tracks, pos) {
  const all = [];
  tracks.forEach((t, ti) => t.chunks.forEach((c, ci) => all.push({ offset: c.offset, size: c.size, ti, ci })));
  all.sort((a, b) => a.offset - b.offset || a.ti - b.ti || a.ci - b.ci);
  const totalBytes = all.reduce((a, c) => a + c.size, 0);
  const large = totalBytes + 8 > U32MAX, hdr = large ? 16 : 8, size = totalBytes + hdr;
  const header = new Uint8Array(hdr);
  if (large) { put32(header, 0, 1); header.set([109, 100, 97, 116], 4); put64(header, 8, size); }
  else { put32(header, 0, size); header.set([109, 100, 97, 116], 4); }
  const chunkOffsets = tracks.map((t) => new Array(t.chunks.length));
  let o = pos + hdr;
  for (const c of all) { chunkOffsets[c.ti][c.ci] = o; o += c.size; }
  return { header, size, dataStart: pos + hdr, chunkOffsets, co64: o > U32MAX, totalBytes, source: { chunks: all, totalBytes } };
}

/** Stream the planned chunks from the source into the output at plan.dataStart (same options as copyApacData). */
export function copyPassthroughData(plan, opts) {
  return copyApacData(plan.source, { ...opts, pos: plan.dataStart });
}

/** New trak for a copied track: tkhd (new ID/duration), edts shifted, tref remapped, mdia/minf verbatim, stbl + new stco/co64. */
export function buildCopiedTrak(track, { trackId, chunkOffsets, outMovieTs, shiftS = 0, tref = [], co64 = null }) {
  if (chunkOffsets.length !== track.chunks.length) throw new Error(`${track.label}: numero di chunk diverso`);
  const tk = track.bytes.tkhd.slice(), v = tk[8], F = TK(v);
  put32(tk, 8 + F.trackId, trackId);
  const edits = shiftEdits(track.edits, { srcMovieTs: track.movieTimescale, outMovieTs, mediaTs: track.mdhd.timescale, shiftS });
  const mediaS = track.mdhd.duration / track.mdhd.timescale;
  const entries = edits && edits.length ? edits : edits ? null : (shiftS > 0 ? [{ segmentDuration: Math.round(Math.max(0, mediaS - shiftS) * outMovieTs), mediaTime: Math.round(shiftS * track.mdhd.timescale), rate: 1 }] : null);
  const durMovie = entries ? entries.reduce((a, e) => a + e.segmentDuration, 0) : Math.round(mediaS * outMovieTs);
  if (v === 1) put64(tk, 8 + F.duration, durMovie); else put32(tk, 8 + F.duration, Math.min(U32MAX, durMovie));
  const useCo64 = co64 ?? chunkOffsets.some((o) => o > U32MAX);
  const off = useCo64 ? makeBox('co64', new Uint8Array(4), be32(chunkOffsets.length), ...chunkOffsets.map(be64))
    : makeBox('stco', new Uint8Array(4), be32(chunkOffsets.length), ...chunkOffsets.map(be32));
  const stbl = makeBox('stbl', ...track.bytes.stbl.map((k) => k.bytes), off);
  // minf: media header (smhd / gmhd / nmhd) and data handler verbatim; dinf verbatim only if it is a self reference
  // (alis/url flag 1: data in this file), otherwise replaced by dref 'url ' self.
  const urlSelf = () => makeBox('dinf', makeBox('dref', new Uint8Array(4), be32(1), makeBox('url ', new Uint8Array([0, 0, 0, 1]))));
  const selfRef = (b) => { const dref = parseBoxes(b, 8, b.length).find((x) => x.type === 'dref'); const e = dref && parseBoxes(b, dref.start + 16, dref.end); return !!(e && e.length === 1 && (b[e[0].start + 11] & 1)); };
  const minfKids = [];
  for (const k of track.bytes.minf) {
    if (k.type === 'stbl') minfKids.push(stbl);
    else if (k.type === 'dinf') minfKids.push(selfRef(k.bytes) ? k.bytes : urlSelf());
    else minfKids.push(k.bytes);
  }
  if (!track.bytes.minf.some((k) => ['smhd', 'gmhd', 'nmhd', 'vmhd', 'sthd'].includes(k.type))) minfKids.unshift(track.handler === 'soun' ? makeBox('smhd', new Uint8Array(8)) : makeBox('nmhd', new Uint8Array(4)));
  if (!track.bytes.minf.some((k) => k.type === 'dinf')) minfKids.splice(minfKids.length - 1, 0, urlSelf());
  const minf = makeBox('minf', ...minfKids);
  const mdia = makeBox('mdia', ...track.bytes.mdia.map((k) => (k.type === 'minf' ? minf : k.bytes)));
  const parts = [tk];
  if (entries && entries.length) parts.push(makeBox('edts', makeElst(entries)));
  const refs = tref.filter((r) => r.ids.length);
  if (refs.length) parts.push(makeBox('tref', ...refs.map((r) => makeBox(r.type, ...r.ids.map(be32)))));
  parts.push(mdia, ...track.bytes.extra.map((k) => k.bytes));
  return { trak: makeBox('trak', ...parts), durationMovie: durMovie };
}

/**
 * Append the selected tracks to the output moov AND lay the moov out like the source (v0.34): every output trak takes
 * the track_ID of its source counterpart (output video <- source video, output AAC <- source AAC, copied track <- its
 * own source ID), traks are ordered as in the source moov (e.g. iPhone: video 1, apac 2, AAC 3, mebx 4...), tref of
 * every trak remapped accordingly, mvhd.next_track_ID = max(source next_track_ID, max ID + 1). Output traks without a
 * source counterpart get new IDs after all others and go last. `tracks` may be empty (only the ID/order alignment).
 * tracks/chunkOffsets from selectPassthrough/planPassthroughMdat; info = readPassthrough(srcMoov).
 * When apac is copied the output AAC gets the source AAC's tkhd flags and the apac alternate_group (players pick ONE
 * of the two, as in the original).
 * Returns {moov, idMap: Map(srcId -> outId), outIdMap: Map(old output ID -> new), added:[{label, entry, srcId, outId, tref, flags, alternateGroup}], dropped:[...]}.
 */
export function addPassthroughTracks(outMoov, info, tracks, { chunkOffsets = [], shiftS = 0, co64 = null, keepSourceIds = true } = {}) {
  const root = parseBoxes(outMoov)[0];
  if (!root || root.type !== 'moov' || root.end !== outMoov.length) throw new Error('outMoov must be exactly one moov box');
  const top = childBoxes(outMoov, root);
  const mvhd = top.find((b) => b.type === 'mvhd'); const mv = mvhdInfo(outMoov, mvhd);
  const traks = top.filter((b) => b.type === 'trak');
  const oldIds = traks.map((t) => tkhdInfo(outMoov, kid(outMoov, t, 'tkhd')).trackId);
  const vIdx = traks.findIndex((t) => trakHandler(outMoov, t) === 'vide');
  const aIdx = traks.findIndex((t) => trakHandler(outMoov, t) === 'soun' && trakSampleEntry(outMoov, t) === 'mp4a');
  // srcId of each output trak (null = no source counterpart)
  const srcOf = traks.map((_, i) => (i === vIdx && info.video ? info.video.trackId : i === aIdx && info.aac ? info.aac.trackId : null));
  const outIdMap = new Map(); // old output ID -> new output ID
  const idMap = new Map(); // source ID -> output ID
  let next;
  if (keepSourceIds) {
    let maxId = Math.max(0, ...(info.order || []), ...tracks.map((t) => t.trackId), ...srcOf.filter((x) => x != null));
    traks.forEach((_, i) => { const n = srcOf[i] != null ? srcOf[i] : ++maxId; outIdMap.set(oldIds[i], n); if (srcOf[i] != null) idMap.set(srcOf[i], n); });
    for (const t of tracks) idMap.set(t.trackId, t.trackId);
    next = Math.max(info.nextTrackId || 0, maxId + 1);
  } else {
    traks.forEach((_, i) => { outIdMap.set(oldIds[i], oldIds[i]); if (srcOf[i] != null) idMap.set(srcOf[i], oldIds[i]); });
    let n = Math.max(mv.nextTrackId, Math.max(0, ...oldIds) + 1);
    for (const t of tracks) idMap.set(t.trackId, n++);
    next = n;
  }
  const added = [], dropped = [], newTraks = [];
  let maxDur = 0;
  tracks.forEach((t, i) => {
    const tref = t.tref.map((r) => ({ type: r.type, ids: r.ids.filter((id) => { const ok = idMap.has(id); if (!ok) dropped.push(`${t.label} ${r.type}→${id}`); return ok; }).map((id) => idMap.get(id)) }));
    const { trak, durationMovie } = buildCopiedTrak(t, { trackId: idMap.get(t.trackId), chunkOffsets: chunkOffsets[i], outMovieTs: mv.timescale, shiftS, tref, co64 });
    maxDur = Math.max(maxDur, durationMovie); newTraks.push({ srcId: t.trackId, bytes: trak });
    added.push({ label: t.label, entry: t.entry, keys: t.keys, srcId: t.trackId, outId: idMap.get(t.trackId), tref: tref.filter((r) => r.ids.length), flags: t.tkhd.flags, alternateGroup: t.tkhd.alternateGroup, samples: t.sampleCount, bytes: t.totalBytes });
  });
  const apac = tracks.find((t) => t.entry === 'apac');
  const aacIdx = apac && aIdx >= 0 && info.aac ? aIdx : -1, g = apac ? apac.tkhd.alternateGroup : 0;
  // output (Mediabunny) traks: new track_ID in tkhd, tref remapped, AAC flags/alternate_group when apac is copied
  const fixTrak = (bytes, i) => rebuild(bytes, (tk) => tk.map((c) => {
    if (c.type === 'tkhd') {
      const b = c.bytes.slice(), v = b[8], F = TK(v);
      put32(b, 8 + F.trackId, outIdMap.get(oldIds[i]));
      if (i === aacIdx) {
        const fl = info.aac.flags;
        b[9] = (fl >> 16) & 255; b[10] = (fl >> 8) & 255; b[11] = fl & 255;
        b[8 + F.alt] = (g >> 8) & 255; b[8 + F.alt + 1] = g & 255;
      }
      return { type: 'tkhd', bytes: b };
    }
    if (c.type === 'tref') {
      const b = c.bytes.slice();
      for (const r of parseBoxes(b, 8, b.length)) for (let o = r.start + r.hdr; o + 4 <= r.end; o += 4) { const id = u32(b, o); if (outIdMap.has(id)) put32(b, o, outIdMap.get(id)); }
      return { type: 'tref', bytes: b };
    }
    return c;
  }));
  // order key: index of the source trak with that ID (unknown -> after everything, stable)
  const srcPos = new Map((info.order || []).map((id, k) => [id, k]));
  const all = [
    ...traks.map((t, i) => ({ key: srcOf[i] != null && srcPos.has(srcOf[i]) ? srcPos.get(srcOf[i]) : 1e6 + i, bytes: fixTrak(boxBytes(outMoov, t), i) })),
    ...newTraks.map((t, j) => ({ key: srcPos.has(t.srcId) ? srcPos.get(t.srcId) : 2e6 + j, bytes: t.bytes })),
  ];
  if (keepSourceIds) all.sort((x, y) => x.key - y.key);
  const nextId = next;
  const moov = rebuild(outMoov, (kids) => {
    const out = []; let placed = false;
    for (const k of kids) {
      if (k.type === 'trak') { if (!placed) { out.push(...all.map((t) => ({ type: 'trak', bytes: t.bytes }))); placed = true; } continue; }
      let bytes = k.bytes;
      if (k.type === 'mvhd') {
        bytes = bytes.slice(); const p = 8;
        if (mv.version === 1) { put32(bytes, p + 108, nextId); if (maxDur > mv.duration) put64(bytes, p + 24, maxDur); }
        else { put32(bytes, p + 96, nextId); if (maxDur > mv.duration) put32(bytes, p + 16, Math.min(U32MAX, maxDur)); }
      }
      out.push({ type: k.type, bytes });
    }
    if (!placed) out.push(...all.map((t) => ({ type: 'trak', bytes: t.bytes })));
    return out;
  });
  return { moov, idMap, outIdMap, added, dropped, aacTrackId: aIdx >= 0 && info.aac ? idMap.get(info.aac.trackId) : 0, alternateGroup: g };
}

/** One-line description of a copied track for the log: "cinematic-audio 5→5 cdsc→3". */
export const describeAdded = (a) => `${a.label} ${a.srcId}→${a.outId}${a.tref.length ? ' ' + a.tref.map((r) => `${r.type}→${r.ids.join(',')}`).join(' ') : ''}`;
