// Dolby Vision helpers: RPU (HEVC NAL type 62) transplant + dvcC/dvvC lookup. Pure ES2020, no deps.
// Works in Safari and Node. All box parsing is read-only and works on Uint8Array views.

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Length-prefixed sample -> array of NAL views (header included, no length prefix) whose type is in nalTypes. */
export function extractNals(sample, nalTypes, lenSize = 4) {
  const out = [];
  let p = 0;
  while (p + lenSize <= sample.length) {
    let n = 0;
    for (let i = 0; i < lenSize; i++) n = n * 256 + sample[p + i];
    p += lenSize;
    if (n === 0 || p + n > sample.length) break;
    if (nalTypes.includes((sample[p] >> 1) & 0x3f)) out.push(sample.subarray(p, p + n));
    p += n;
  }
  return out;
}

/** Append NALs (length-prefixed) at the end of the sample. In DV the RPU is the last NAL of the access unit. */
export function appendNals(sample, nals, lenSize = 4) {
  let extra = 0;
  for (const n of nals) extra += lenSize + n.length;
  const out = new Uint8Array(sample.length + extra);
  out.set(sample, 0);
  let p = sample.length;
  for (const n of nals) {
    let v = n.length;
    for (let i = lenSize - 1; i >= 0; i--) { out[p + i] = v & 255; v = Math.floor(v / 256); }
    out.set(n, p + lenSize);
    p += lenSize + n.length;
  }
  return out;
}

// ---- box parsing -----------------------------------------------------------------------------

// Bytes between a box header and its first child, for the container-ish boxes we descend into.
const SAMPLE_ENTRIES = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe', 'avc1', 'avc3', 'dva1', 'dvav']);
export function childrenOffset(buf, box) {
  const t = box.type;
  if (t === 'stsd') return box.hdr + 8;
  if (SAMPLE_ENTRIES.has(t)) return box.hdr + 78; // VisualSampleEntry
  if (t === 'meta') { // ISO full box (4 byte version/flags) vs QuickTime plain box (iPhone)
    return fourcc(buf, box.start + box.hdr + 4) === 'hdlr' ? box.hdr : box.hdr + 4;
  }
  return box.hdr;
}
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'stsd', 'meta', ...SAMPLE_ENTRIES]);
export const isContainer = (t) => CONTAINERS.has(t);

/** Parse sibling boxes in buf[start,end). Returns [{type,start,end,hdr}] (absolute offsets in buf). */
export function parseBoxes(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(buf, p), hdr = 8;
    const type = fourcc(buf, p + 4);
    if (size === 1) { size = u64(buf, p + 8); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, end: p + size, hdr });
    p += size;
  }
  return out;
}
export const boxBytes = (buf, b) => buf.subarray(b.start, b.end);
export function childBoxes(buf, box) {
  return parseBoxes(buf, box.start + childrenOffset(buf, box), box.end);
}

/** Handler type ('vide', 'soun', ...) of a trak box. */
export function trakHandler(buf, trak) {
  const mdia = childBoxes(buf, trak).find((b) => b.type === 'mdia');
  const hdlr = mdia && childBoxes(buf, mdia).find((b) => b.type === 'hdlr');
  return hdlr ? fourcc(buf, hdlr.start + hdlr.hdr + 8) : null;
}

/**
 * Find the first box at `path` below the top level of buf. Each path element is a fourcc string or a
 * predicate (buf, box) => bool (e.g. to pick the video trak). Returns {type,start,end,hdr} or null.
 * Use boxBytes(buf, box) for the bytes including header.
 */
export function findBox(buf, path, start = 0, end = buf.length) {
  let boxes = parseBoxes(buf, start, end);
  let cur = null;
  for (const el of path) {
    cur = boxes.find((b) => (typeof el === 'string' ? b.type === el : b.type === el.type && (!el.pred || el.pred(buf, b))));
    if (!cur) return null;
    boxes = childBoxes(buf, cur);
  }
  return cur;
}
export const videoTrak = { type: 'trak', pred: (buf, b) => trakHandler(buf, b) === 'vide' };

/**
 * Bytes (complete box with header) of dvcC / dvvC found in
 * moov/trak(video)/mdia/minf/stbl/stsd/<sample entry>. `moov` is the moov box alone (header included).
 */
export function extractDoviConfigBox(moov) {
  const stsd = findBox(moov, ['moov', videoTrak, 'mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd) return null;
  for (const entry of childBoxes(moov, stsd)) {
    const dv = childBoxes(moov, entry).find((b) => b.type === 'dvcC' || b.type === 'dvvC');
    if (dv) return moov.slice(dv.start, dv.end);
  }
  return null;
}

/**
 * Locate the top-level moov by reading only box headers.
 * read(offset, len) -> Promise<Uint8Array> (may return fewer bytes at EOF); size = total size if known.
 * Returns {offset, size} (size includes header) or null.
 */
export async function locateMoov(read, size = Infinity) {
  let off = 0;
  while (off + 8 <= size) {
    const h = await read(off, 16);
    if (h.length < 8) return null;
    let sz = u32(h, 0), type = fourcc(h, 4);
    if (sz === 1) sz = u64(h, 8);
    else if (sz === 0) sz = size - off; // extends to EOF
    if (type === 'moov') return { offset: off, size: sz };
    if (sz < 8) throw new Error('corrupt box size at ' + off);
    off += sz;
  }
  return null;
}
