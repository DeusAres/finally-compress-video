// Passthrough of the Apple spatial audio track ('apac', Apple Positional Audio Codec, iPhone: 4 ch FOA 48 kHz).
// No browser decodes apac and Mediabunny cannot mux it (research/04 §1.2, §5): its samples are copied BYTE FOR BYTE
// from the source file into a second 'mdat' appended after Mediabunny's mdat, and a new 'trak' (stsd and sample tables
// verbatim, new stco/co64) is added to the output moov. Pure ES2020, no deps; works in Safari and Node.
//
// Output layout (moov at the end, fastStart:false):  [ftyp][mdat Mediabunny][mdat apac][moov + trak apac]
// Time alignment: the video pipeline rebases timestamps by -frames[0].ts (usually 0) and drops packets with ts<0.
// For apac NO sample is cut: the same shift is applied through the edit list (media_time += shift, duration -= shift),
// so the presentation of apac matches the source exactly (priming kept as in the source elst).
import { parseBoxes, childBoxes, findBox, boxBytes, trakHandler } from './dovi.js?v=0.34.1';
import { makeBox, rebuild } from './mp4-post.js?v=0.34.1';

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const i64 = (b, o) => { const hi = u32(b, o) | 0; return hi * 4294967296 + u32(b, o + 4); };
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const put32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const put64 = (b, o, v) => { const hi = Math.floor(v / 4294967296); put32(b, o, hi >>> 0); put32(b, o + 4, (v - hi * 4294967296) >>> 0); };
const be32 = (v) => { const b = new Uint8Array(4); put32(b, 0, v >>> 0); return b; };
const be64 = (v) => { const b = new Uint8Array(8); put64(b, 0, v); return b; };
const U32MAX = 4294967295;

/** First sample-entry type of a trak's stsd (e.g. 'apac', 'mp4a'), or null. */
export function trakSampleEntry(buf, trak) {
  const stsd = findBox(buf, ['mdia', 'minf', 'stbl', 'stsd'], trak.start + trak.hdr, trak.end);
  if (!stsd) return null;
  const e = parseBoxes(buf, stsd.start + stsd.hdr + 8, stsd.end)[0];
  return e ? e.type : null;
}
export const kid = (buf, box, t) => childBoxes(buf, box).find((b) => b.type === t) || null;

// ---- tkhd / mvhd / mdhd field access (version 0 and 1) ----------------------------------------------------------
export function tkhdInfo(buf, box) {
  const p = box.start + box.hdr, v = buf[p], o = v === 1 ? 8 : 0;
  return {
    version: v, flags: (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3],
    trackId: u32(buf, p + 12 + o), duration: v === 1 ? u64(buf, p + 28) : u32(buf, p + 20),
    layer: u16(buf, p + 32 + o + (v === 1 ? 4 : 0)), alternateGroup: u16(buf, p + 34 + o + (v === 1 ? 4 : 0)),
    volume: u16(buf, p + 36 + o + (v === 1 ? 4 : 0)) / 256,
  };
}
// payload offsets (from box.start + hdr) of tkhd fields
export const TK = (v) => v === 1 ? { trackId: 20, duration: 28, alt: 46 } : { trackId: 12, duration: 20, alt: 34 };
export function mvhdInfo(buf, box) {
  const p = box.start + box.hdr, v = buf[p];
  return v === 1 ? { version: 1, timescale: u32(buf, p + 20), duration: u64(buf, p + 24), nextTrackId: u32(buf, p + 108) }
    : { version: 0, timescale: u32(buf, p + 12), duration: u32(buf, p + 16), nextTrackId: u32(buf, p + 96) };
}
export function mdhdInfo(buf, box) {
  const p = box.start + box.hdr, v = buf[p];
  const lang = u16(buf, p + (v === 1 ? 32 : 20));
  const language = String.fromCharCode(((lang >> 10) & 31) + 0x60, ((lang >> 5) & 31) + 0x60, (lang & 31) + 0x60);
  return v === 1 ? { timescale: u32(buf, p + 20), duration: u64(buf, p + 24), language } : { timescale: u32(buf, p + 12), duration: u32(buf, p + 16), language };
}
/** Edit list entries [{segmentDuration (movie ts), mediaTime (media ts, -1 = empty), rate}] or null. */
export function readElst(buf, edts) {
  const elst = edts && kid(buf, edts, 'elst'); if (!elst) return null;
  const p = elst.start + elst.hdr, v = buf[p], n = u32(buf, p + 4), out = [];
  for (let i = 0, q = p + 8; i < n; i++) {
    if (v === 1) { out.push({ segmentDuration: u64(buf, q), mediaTime: i64(buf, q + 8), rate: (u32(buf, q + 16) | 0) / 65536 }); q += 20; }
    else { out.push({ segmentDuration: u32(buf, q), mediaTime: u32(buf, q + 4) | 0, rate: (u32(buf, q + 8) | 0) / 65536 }); q += 12; }
  }
  return out;
}

/**
 * Per-sample sizes/offsets and per-chunk {offset, size, samples} from stsz + stsc + stco/co64 (boxes of buf).
 * Returns {sampleCount, sampleOffsets (Float64Array), sampleSizes (Uint32Array), chunks, totalBytes}.
 */
export function sampleLayout(srcMoov, stsz, stsc, stco, what = 'traccia') {
  const zp = stsz.start + stsz.hdr, constSize = u32(srcMoov, zp + 4), n = u32(srcMoov, zp + 8);
  const sampleSizes = new Uint32Array(n);
  for (let i = 0; i < n; i++) sampleSizes[i] = constSize || u32(srcMoov, zp + 12 + 4 * i);
  const cp = stco.start + stco.hdr, nChunks = u32(srcMoov, cp + 4), co64 = stco.type === 'co64';
  const chunkOff = (i) => (co64 ? u64(srcMoov, cp + 8 + 8 * i) : u32(srcMoov, cp + 8 + 4 * i));
  const scp = stsc.start + stsc.hdr, nsc = u32(srcMoov, scp + 4);
  const runs = Array.from({ length: nsc }, (_, i) => ({ first: u32(srcMoov, scp + 8 + 12 * i), per: u32(srcMoov, scp + 12 + 12 * i) }));
  const sampleOffsets = new Float64Array(n), chunks = [];
  let s = 0;
  for (let c = 0; c < nChunks && s < n; c++) {
    let r = 0; while (r + 1 < runs.length && runs[r + 1].first <= c + 1) r++;
    const per = runs[r]?.per || 0, off0 = chunkOff(c); let off = off0, k = 0;
    for (; k < per && s < n; k++, s++) { sampleOffsets[s] = off; off += sampleSizes[s]; }
    chunks.push({ offset: off0, size: off - off0, samples: k });
  }
  if (s !== n) throw new Error(`${what}: stsc/stco coprono ${s} campioni su ${n}`);
  const totalBytes = chunks.reduce((a, c) => a + c.size, 0);
  return { sampleCount: n, sampleOffsets, sampleSizes, chunks, totalBytes };
}

/**
 * Find the apac trak in a source moov and extract everything needed to transplant it.
 * Returns null if there is no audio trak with an 'apac' sample entry.
 * {trackId, tkhd:{flags, alternateGroup, volume, duration}, mdhd:{timescale, duration, language}, movieTimescale,
 *  channels, sampleRate, edits, fallbackTrackId, sourceAac:{trackId, flags, alternateGroup} | null,
 *  bytes:{tkhd, mdhd, hdlr, smhd, stsd, stbl:[{type,bytes}] (without stco/co64)},
 *  sampleCount, sampleOffsets (Float64Array), sampleSizes (Uint32Array), chunks:[{offset, size, samples}], totalBytes}
 */
export function readApacTrack(srcMoov) {
  const root = parseBoxes(srcMoov)[0];
  if (!root || root.type !== 'moov') return null;
  const top = childBoxes(srcMoov, root);
  const mvhd = top.find((b) => b.type === 'mvhd');
  const traks = top.filter((b) => b.type === 'trak');
  const trak = traks.find((t) => trakHandler(srcMoov, t) === 'soun' && trakSampleEntry(srcMoov, t) === 'apac');
  if (!trak || !mvhd) return null;
  const tk = kid(srcMoov, trak, 'tkhd'), mdia = kid(srcMoov, trak, 'mdia');
  const mdhd = kid(srcMoov, mdia, 'mdhd'), hdlr = kid(srcMoov, mdia, 'hdlr'), minf = kid(srcMoov, mdia, 'minf');
  const smhd = kid(srcMoov, minf, 'smhd'), stbl = kid(srcMoov, minf, 'stbl');
  const sk = childBoxes(srcMoov, stbl), get = (t) => sk.find((b) => b.type === t) || null;
  const stsd = get('stsd'), stsz = get('stsz'), stsc = get('stsc'), stco = get('stco') || get('co64');
  if (!tk || !mdhd || !hdlr || !stsd || !stsz || !stsc || !stco || !get('stts')) throw new Error('apac: tabelle campioni incomplete' + (get('stz2') ? ' (stz2 non supportato)' : ''));
  const tkhd = tkhdInfo(srcMoov, tk);
  // fallback reference (tref/fall -> AAC track) and the source AAC trak (flags/alternate group to replicate)
  const tref = kid(srcMoov, trak, 'tref');
  let fallbackTrackId = 0;
  if (tref) for (const r of childBoxes(srcMoov, tref)) if (r.type === 'fall' && r.end - r.start >= 12) fallbackTrackId = u32(srcMoov, r.start + 8);
  const aacTraks = traks.filter((t) => trakHandler(srcMoov, t) === 'soun' && trakSampleEntry(srcMoov, t) === 'mp4a');
  const aacT = aacTraks.find((t) => tkhdInfo(srcMoov, kid(srcMoov, t, 'tkhd')).trackId === fallbackTrackId) || aacTraks[0];
  const aacI = aacT ? tkhdInfo(srcMoov, kid(srcMoov, aacT, 'tkhd')) : null;
  // sample entry: QuickTime SoundDescription v0/v1/v2 (iPhone: v2 with float64 sample rate)
  const se = parseBoxes(srcMoov, stsd.start + stsd.hdr + 8, stsd.end)[0], sp = se.start + 8;
  const sdv = u16(srcMoov, sp + 8);
  let channels = u16(srcMoov, sp + 16), sampleRate = u32(srcMoov, sp + 24) / 65536;
  if (sdv === 2) { channels = u32(srcMoov, sp + 40); sampleRate = new DataView(srcMoov.buffer, srcMoov.byteOffset + sp + 32, 8).getFloat64(0); }
  const { sampleCount: n, sampleOffsets, sampleSizes, chunks, totalBytes } = sampleLayout(srcMoov, stsz, stsc, stco, 'apac');
  return {
    trackId: tkhd.trackId, tkhd, mdhd: mdhdInfo(srcMoov, mdhd), movieTimescale: mvhdInfo(srcMoov, mvhd).timescale,
    channels, sampleRate, edits: readElst(srcMoov, kid(srcMoov, trak, 'edts')), fallbackTrackId,
    sourceAac: aacI ? { trackId: aacI.trackId, flags: aacI.flags, alternateGroup: aacI.alternateGroup } : null,
    bytes: {
      tkhd: boxBytes(srcMoov, tk).slice(), mdhd: boxBytes(srcMoov, mdhd).slice(), hdlr: boxBytes(srcMoov, hdlr).slice(),
      smhd: smhd ? boxBytes(srcMoov, smhd).slice() : null, stsd: boxBytes(srcMoov, stsd).slice(),
      stbl: sk.filter((b) => b.type !== 'stco' && b.type !== 'co64').map((b) => ({ type: b.type, bytes: boxBytes(srcMoov, b).slice() })),
    },
    sampleCount: n, sampleOffsets, sampleSizes, chunks, totalBytes,
  };
}

/**
 * Edit list shifted by `shift` seconds (presentation trimmed at the start, as the video pipeline does with -frames[0].ts)
 * and rescaled from the source movie timescale to the output one. Samples are never cut: media_time moves forward.
 */
export function shiftEdits(edits, { srcMovieTs, outMovieTs, mediaTs, shiftS = 0 }) {
  if (!edits || !edits.length) return null; // no source edit list: caller builds one if a shift is needed
  let skip = Math.max(0, shiftS) * srcMovieTs; // movie-time units still to drop
  const out = [];
  for (const e of edits || []) {
    let d = e.segmentDuration, mt = e.mediaTime;
    if (skip > 0) {
      const cut = Math.min(d, skip); d -= cut; skip -= cut;
      if (mt >= 0) mt += Math.round(cut / srcMovieTs * mediaTs * (e.rate || 1));
    }
    if (d <= 0) continue;
    out.push({ segmentDuration: Math.round(d / srcMovieTs * outMovieTs), mediaTime: mt, rate: e.rate });
  }
  return out;
}
export function makeElst(entries) {
  const v1 = entries.some((e) => e.segmentDuration > U32MAX || e.mediaTime > 2147483647);
  const parts = [new Uint8Array([v1 ? 1 : 0, 0, 0, 0]), be32(entries.length)];
  for (const e of entries) {
    if (v1) parts.push(be64(e.segmentDuration), be64(Math.max(0, e.mediaTime))); // -1 (empty edit) filled below
    else parts.push(be32(e.segmentDuration), be32(e.mediaTime < 0 ? U32MAX : e.mediaTime));
    const r = Math.round((e.rate ?? 1) * 65536); parts.push(be32(r));
  }
  const b = makeBox('elst', ...parts);
  if (v1) for (let i = 0, q = 16; i < entries.length; i++, q += 20) if (entries[i].mediaTime < 0) b.fill(255, q + 8, q + 16);
  return b;
}

/**
 * Layout of the apac data appended at `pos` (= prefixLength: where Mediabunny's moov was) as its own 'mdat'.
 * Returns {header (Uint8Array), size (whole box), dataStart, chunkOffsets (absolute, one per source chunk), co64}.
 */
export function planApacMdat(track, pos) {
  const large = track.totalBytes + 8 > U32MAX, hdr = large ? 16 : 8, size = track.totalBytes + hdr;
  const header = new Uint8Array(hdr);
  if (large) { put32(header, 0, 1); header.set([109, 100, 97, 116], 4); put64(header, 8, size); }
  else { put32(header, 0, size); header.set([109, 100, 97, 116], 4); }
  const chunkOffsets = []; let o = pos + hdr;
  for (const c of track.chunks) { chunkOffsets.push(o); o += c.size; }
  return { header, size, dataStart: pos + hdr, chunkOffsets, co64: o > U32MAX };
}

/**
 * Stream the apac chunks from the source into the output, in order, starting at `pos` (= plan.dataStart).
 * read(offset, len) -> Promise<Uint8Array> (source, e.g. File.slice); write(pos, u8) -> Promise (output, e.g. OPFS worker).
 * Adjacent source chunks are merged; output is written in blocks of ~blockSize (no accumulation in RAM).
 * Returns the number of bytes written.
 */
export async function copyApacData(track, { read, write, pos, blockSize = 1 << 20, concurrency = 6, onProgress, check }) {
  const ranges = []; // merged contiguous source ranges
  for (const c of track.chunks) {
    if (!c.size) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.offset + last.size === c.offset && last.size + c.size <= blockSize) last.size += c.size;
    else ranges.push({ offset: c.offset, size: c.size });
  }
  let buf = new Uint8Array(blockSize), fill = 0, written = 0, outPos = pos;
  const flush = async () => { if (!fill) return; await write(outPos, buf.subarray(0, fill)); outPos += fill; written += fill; fill = 0; };
  const fetchR = async (r) => { const d = await read(r.offset, r.size); if (d.length !== r.size) throw new Error(`apac: letti ${d.length}/${r.size} byte a ${r.offset}`); return d; };
  const inflight = [];
  for (let i = 0; i < Math.min(concurrency, ranges.length); i++) inflight.push(fetchR(ranges[i]));
  for (let i = 0; i < ranges.length; i++) {
    const d = await inflight.shift();
    if (i + concurrency < ranges.length) inflight.push(fetchR(ranges[i + concurrency]));
    if (fill + d.length > buf.length) await flush();
    if (d.length > buf.length) { await write(outPos, d); outPos += d.length; written += d.length; }
    else { buf.set(d, fill); fill += d.length; }
    if (check) await check();
    onProgress?.((written + fill) / track.totalBytes);
  }
  await flush(); buf = null;
  if (written !== track.totalBytes) throw new Error(`apac: copiati ${written}/${track.totalBytes} byte`);
  return written;
}

/** New apac trak (track_ID = trackId, stsd/sample tables verbatim, new stco/co64). */
export function buildApacTrak(track, { trackId, chunkOffsets, outMovieTs, shiftS = 0, fallbackTrackId = 0, co64 = null }) {
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
  if (chunkOffsets.length !== track.chunks.length) throw new Error('apac: numero di chunk diverso');
  const stbl = makeBox('stbl', ...track.bytes.stbl.map((k) => k.bytes), off);
  const urlSelf = makeBox('url ', new Uint8Array([0, 0, 0, 1]));
  const dinf = makeBox('dinf', makeBox('dref', new Uint8Array(4), be32(1), urlSelf));
  const smhd = track.bytes.smhd || makeBox('smhd', new Uint8Array(8));
  const mdia = makeBox('mdia', track.bytes.mdhd, track.bytes.hdlr, makeBox('minf', smhd, dinf, stbl));
  const parts = [tk];
  if (entries && entries.length) parts.push(makeBox('edts', makeElst(entries)));
  if (fallbackTrackId) parts.push(makeBox('tref', makeBox('fall', be32(fallbackTrackId))));
  parts.push(mdia);
  return { trak: makeBox('trak', ...parts), durationMovie: durMovie };
}

/**
 * Add the apac trak to the output moov (after the last trak), update mvhd.next_track_ID / duration, and give the AAC trak
 * of the output the source AAC's tkhd flags (e.g. disabled) and the apac alternate_group, so players pick ONE of the two
 * (iPhone: apac enabled, AAC disabled fallback in the same group, tref 'fall' apac -> AAC).
 * Returns {moov, trackId, alternateGroup, aacTrackId}.
 */
export function addApacTrack(outMoov, track, { chunkOffsets, shiftS = 0, co64 = null }) {
  const root = parseBoxes(outMoov)[0];
  if (!root || root.type !== 'moov' || root.end !== outMoov.length) throw new Error('outMoov must be exactly one moov box');
  const top = childBoxes(outMoov, root);
  const mvhd = top.find((b) => b.type === 'mvhd'); const mv = mvhdInfo(outMoov, mvhd);
  const traks = top.filter((b) => b.type === 'trak');
  let maxId = 0; for (const t of traks) maxId = Math.max(maxId, tkhdInfo(outMoov, kid(outMoov, t, 'tkhd')).trackId);
  const trackId = Math.max(mv.nextTrackId, maxId + 1);
  const aac = traks.find((t) => trakHandler(outMoov, t) === 'soun' && trakSampleEntry(outMoov, t) === 'mp4a');
  const aacTrackId = aac ? tkhdInfo(outMoov, kid(outMoov, aac, 'tkhd')).trackId : 0;
  const { trak, durationMovie } = buildApacTrak(track, { trackId, chunkOffsets, outMovieTs: mv.timescale, shiftS, fallbackTrackId: track.fallbackTrackId && aacTrackId ? aacTrackId : 0, co64 });
  const g = track.tkhd.alternateGroup;
  let aacIdx = aac ? traks.indexOf(aac) : -1, ti = -1;
  const moov = rebuild(outMoov, (kids) => {
    const out = []; let lastTrak = -1;
    for (const k of kids) {
      let bytes = k.bytes;
      if (k.type === 'mvhd') {
        bytes = bytes.slice(); const p = 8;
        if (mv.version === 1) { put32(bytes, p + 108, trackId + 1); if (durationMovie > mv.duration) put64(bytes, p + 24, durationMovie); }
        else { put32(bytes, p + 96, trackId + 1); if (durationMovie > mv.duration) put32(bytes, p + 16, Math.min(U32MAX, durationMovie)); }
      }
      if (k.type === 'trak') {
        ti++;
        if (ti === aacIdx && track.sourceAac) {
          bytes = rebuild(bytes, (tk) => tk.map((c) => {
            if (c.type !== 'tkhd') return c;
            const b = c.bytes.slice(), v = b[8], F = TK(v);
            b[9] = (track.sourceAac.flags >> 16) & 255; b[10] = (track.sourceAac.flags >> 8) & 255; b[11] = track.sourceAac.flags & 255;
            b[8 + F.alt] = (g >> 8) & 255; b[8 + F.alt + 1] = g & 255;
            return { type: 'tkhd', bytes: b };
          }));
        }
        lastTrak = out.length;
      }
      out.push({ type: k.type, bytes });
    }
    out.splice(lastTrak + 1, 0, { type: 'trak', bytes: trak });
    return out;
  });
  return { moov, trackId, alternateGroup: g, aacTrackId };
}

/** Read tkhd {trackId, flags, alternateGroup, volume, duration} of every trak (tests / diagnostics). */
export function listTracks(moov) {
  const root = parseBoxes(moov)[0];
  return childBoxes(moov, root).filter((b) => b.type === 'trak').map((t) => ({ ...tkhdInfo(moov, kid(moov, t, 'tkhd')), handler: trakHandler(moov, t), entry: trakSampleEntry(moov, t), edits: readElst(moov, kid(moov, t, 'edts')) }));
}
