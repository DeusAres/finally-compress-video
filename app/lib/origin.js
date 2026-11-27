// Originale o versione esportata? Analisi rapida (sola lettura) di moov + ftyp di un MOV/MP4 dell'iPhone.
// Usata dall'app (avviso «versione compatibile») e da tools/diag/import.html. Pura ES2020, funziona in Safari e Node.
// Indizi misurati su file reali (docs/research/17-import-originale.md §4): la copia che iOS consegna dalla Libreria Foto
// (o da un trascinamento) è RICODIFICATA da Foto: chiave com.apple.quicktime.displayname aggiunta, traccia AAC spostata
// prima del video, apac (audio spaziale) tolto, 4K ridotto a 1080p, mvhd con l'ora dell'esportazione. Questi indizi da soli NON bastano (originali recenti hanno audio
// prima del video e displayname): vedi judgeOrigin.
import { parseBoxes, childBoxes, trakHandler } from './dovi.js?v=0.38.7';

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const cc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const utf8 = (b, s, e) => new TextDecoder().decode(b.subarray(s, e));
const kid = (b, box, t) => childBoxes(b, box).find((x) => x.type === t) || null;
const pay = (box) => box.start + box.hdr; // inizio del contenuto (dopo l'header)
const MAC_EPOCH = 2082844800; // secondi tra 1904-01-01 e 1970-01-01
const TRANSFER = { 1: 'BT.709', 14: 'BT.2020', 16: 'PQ', 18: 'HLG' };

/** ftyp dai primi byte del file → {major, minor, compat:[...]} o null. */
export function parseFtyp(head) {
  if (!head || head.length < 16 || cc(head, 4) !== 'ftyp') return null;
  const size = Math.min(u32(head, 0), head.length), compat = [];
  for (let p = 16; p + 4 <= size; p += 4) compat.push(cc(head, p));
  return { major: cc(head, 8), minor: u32(head, 12), compat };
}

/** moov/meta (QuickTime mdta) → {chiave: valore} (stringhe UTF-8, interi; altro come esadecimale corto). */
export function readMetaKeys(moov, metaBox) {
  const out = {}; if (!metaBox) return out;
  const kids = childBoxes(moov, metaBox), keys = kids.find((b) => b.type === 'keys'), ilst = kids.find((b) => b.type === 'ilst');
  if (!keys) return out;
  const names = []; let p = pay(keys) + 8; const n = u32(moov, pay(keys) + 4);
  for (let i = 0; i < n && p + 8 <= keys.end; i++) { const sz = u32(moov, p); if (sz < 8) break; names.push(utf8(moov, p + 8, p + sz)); p += sz; }
  for (const k of names) out[k] = null;
  if (ilst) for (const it of parseBoxes(moov, pay(ilst), ilst.end)) {
    const idx = u32(moov, it.start + 4), name = names[idx - 1]; if (!name) continue;
    const data = parseBoxes(moov, pay(it), it.end).find((b) => b.type === 'data'); if (!data) continue;
    const t = u32(moov, pay(data)) & 0xffffff, s = pay(data) + 8, e = data.end, len = e - s;
    if (t === 1) out[name] = utf8(moov, s, e);
    else if ((t === 21 || t === 22) && len >= 1 && len <= 4) { let v = 0; for (let i = s; i < e; i++) v = v * 256 + moov[i]; if (t === 21 && moov[s] & 0x80) v -= 2 ** (8 * len); out[name] = v; }
    else if (t === 23 && len === 4) out[name] = new DataView(moov.buffer, moov.byteOffset + s, 4).getFloat32(0);
    else out[name] = `<${len} B tipo ${t}>`;
  }
  return out;
}

function mebxKeys(moov, entry) {
  const out = [], keys = parseBoxes(moov, entry.start + 16, entry.end).find((b) => b.type === 'keys'); if (!keys) return out;
  for (const k of parseBoxes(moov, pay(keys), keys.end)) {
    const keyd = parseBoxes(moov, pay(k), k.end).find((b) => b.type === 'keyd');
    if (keyd && keyd.end > pay(keyd) + 4) out.push(utf8(moov, pay(keyd) + 4, keyd.end).replace(/^com\.apple\.quicktime\./, ''));
  }
  return out;
}

function videoEntry(moov, e, t) {
  const p = pay(e); t.w = u16(moov, p + 24); t.h = u16(moov, p + 26);
  for (const c of childBoxes(moov, e)) {
    const q = pay(c);
    if (c.type === 'hvcC' && c.end - q >= 23) Object.assign(t, { codec: 'HEVC', profile: moov[q + 1] & 31, level: moov[q + 12], chroma: moov[q + 16] & 3, bitDepth: (moov[q + 17] & 7) + 8, bitDepthChroma: (moov[q + 18] & 7) + 8 });
    else if (c.type === 'avcC' && c.end - q >= 4) Object.assign(t, { codec: 'H.264', profile: moov[q + 1], level: moov[q + 3], bitDepth: 8 });
    else if ((c.type === 'dvvC' || c.type === 'dvcC' || c.type === 'dvwC') && c.end - q >= 5) t.dv = { box: c.type, profile: moov[q + 2] >> 1, level: ((moov[q + 2] & 1) << 5) | (moov[q + 3] >> 3), compat: moov[q + 4] >> 4 };
    else if (c.type === 'colr' && c.end - q >= 10 && /^ncl[xc]$/.test(cc(moov, q))) { const tr = u16(moov, q + 6); t.colr = { primaries: u16(moov, q + 4), transfer: tr, matrix: u16(moov, q + 8) }; t.transfer = TRANSFER[tr] || String(tr); }
  }
  t.children = childBoxes(moov, e).map((c) => c.type);
}

/**
 * Analisi del moov (box completo, header incluso) + primi byte del file (ftyp).
 * → {ftyp, mvhdCreation (ISO|null), keys:{…}, tracks:[{id, handler, entry, codec?, w, h, bitDepth?, dv?, transfer?, keys?, channels?, bytes, durS, kbps}]}
 */
export function inspectMovie(moov, head = null) {
  const top = parseBoxes(moov)[0]; if (!top || top.type !== 'moov') throw new Error('moov non valido');
  const kids = childBoxes(moov, top), mvhd = kids.find((b) => b.type === 'mvhd');
  let mvhdCreation = null;
  if (mvhd) { const v = moov[pay(mvhd)], s = v === 1 ? u64(moov, pay(mvhd) + 4) : u32(moov, pay(mvhd) + 4); if (s > MAC_EPOCH) mvhdCreation = new Date((s - MAC_EPOCH) * 1000).toISOString(); }
  const udta = kids.find((b) => b.type === 'udta');
  const keys = { ...(udta ? readMetaKeys(moov, kid(moov, udta, 'meta')) : {}), ...readMetaKeys(moov, kids.find((b) => b.type === 'meta')) };
  const tracks = [];
  for (const trak of kids.filter((b) => b.type === 'trak')) {
    const t = { handler: trakHandler(moov, trak) };
    const tk = kid(moov, trak, 'tkhd'); if (tk) t.id = u32(moov, pay(tk) + (moov[pay(tk)] === 1 ? 20 : 12));
    const mdia = kid(moov, trak, 'mdia'), mdhd = mdia && kid(moov, mdia, 'mdhd'), minf = mdia && kid(moov, mdia, 'minf'), stbl = minf && kid(moov, minf, 'stbl');
    if (mdhd) { const q = pay(mdhd), v1 = moov[q] === 1, ts = u32(moov, q + (v1 ? 20 : 12)), d = v1 ? u64(moov, q + 24) : u32(moov, q + 16); t.durS = ts ? +(d / ts).toFixed(3) : 0; }
    const stsd = stbl && kid(moov, stbl, 'stsd'), stsz = stbl && kid(moov, stbl, 'stsz');
    if (stsz) { const q = pay(stsz), ss = u32(moov, q + 4), n = u32(moov, q + 8); let s = ss * n; if (!ss) for (let i = 0; i < n && q + 16 + 4 * i <= stsz.end; i++) s += u32(moov, q + 12 + 4 * i); t.bytes = s; t.kbps = t.durS ? Math.round(s * 8 / t.durS / 1000) : 0; }
    const e = stsd ? childBoxes(moov, stsd)[0] : null;
    t.entry = e ? e.type : '?';
    if (e && t.handler === 'vide') videoEntry(moov, e, t);
    else if (e && t.handler === 'soun') { t.codec = t.entry === 'mp4a' ? 'AAC' : t.entry === 'apac' ? 'APAC (audio spaziale)' : t.entry; t.channels = u16(moov, pay(e) + 16); }
    else if (e && t.entry === 'mebx') t.keys = mebxKeys(moov, e);
    tracks.push(t);
  }
  return { ftyp: parseFtyp(head), mvhdCreation, keys, tracks };
}

/** Data di com.apple.quicktime.creationdate ('2026-11-18T23:40:14+0100') → ms, o NaN. */
const parseCreation = (s) => typeof s === 'string' ? Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : NaN;

/**
 * Giudizio: 'originale' (file della fotocamera), 'esportato' (copia ricodificata da Foto/iOS: «versione compatibile»)
 * o 'sconosciuto' (non sembra un video dell'iPhone). reasons = indizi di esportazione; notes = osservazioni deboli.
 */
export function judgeOrigin(info, name = '') {
  const k = info.keys || {}, tr = info.tracks || [], v = tr.find((t) => t.handler === 'vide');
  const apple = k['com.apple.quicktime.make'] === 'Apple' || /^IMG_\d+/i.test(name);
  const reasons = [], notes = [];
  if (!v || !apple) return { verdict: 'sconosciuto', reasons, notes: v ? ['nessuna marca Apple nei metadati e nome non IMG_xxxx'] : ['nessuna traccia video'] };
  // Solo prove forti producono 'esportato' (avviso in UI). displayname e ordine delle tracce NON bastano: compaiono anche
  // negli originali recenti (es. audio cinematic: «mappa ID 2→2 1→1 3→3», audio prima del video).
  const imgName = /^IMG_\d+/i.test(name);
  const first = tr.find((t) => t.handler === 'vide' || t.handler === 'soun');
  const mebx = tr.filter((t) => t.entry === 'mebx').length;
  if (imgName && v.codec === 'H.264' && !mebx) reasons.push('video H.264 (avc1) senza tracce metadati iPhone in un file IMG_xxxx');
  if (imgName && v.codec === 'HEVC' && v.bitDepth === 8 && !mebx) reasons.push('HEVC a 8 bit senza tracce metadati iPhone in un file IMG_xxxx');
  if ('com.apple.quicktime.displayname' in k) notes.push('chiave «displayname» presente (indizio debole: compare anche in alcuni originali)');
  if (first && first.handler === 'soun') notes.push('traccia audio prima del video (indizio debole: normale anche negli originali recenti)');
  if (!mebx) notes.push('nessuna traccia metadati iPhone (mebx)');
  if (!tr.some((t) => t.entry === 'apac')) notes.push('nessun audio spaziale (apac): normale se registrato senza, ma l\'esportazione lo toglie');
  if (v.codec === 'HEVC' && v.bitDepth === 8) notes.push('HEVC 8 bit (SDR): normale se l\'HDR era spento, tipico di «Più compatibile»');
  if (v.codec === 'H.264') notes.push('H.264: normale se la fotocamera è su «Più compatibile»');
  const cd = parseCreation(k['com.apple.quicktime.creationdate']), mv = info.mvhdCreation ? Date.parse(info.mvhdCreation) : NaN;
  if (Number.isFinite(cd) && Number.isFinite(mv) && Math.abs(mv - cd) > 120e3) notes.push(`file scritto ${Math.round((mv - cd) / 60e3)} min dopo la ripresa (esportazione o modifica in Foto)`);
  return { verdict: reasons.length ? 'esportato' : 'originale', reasons, notes };
}
