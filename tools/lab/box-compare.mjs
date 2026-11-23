// Box-by-box comparison (moov structure) of an original iPhone .mov and an output file, as a Markdown table.
// Usage: node tools/lab/box-compare.mjs original.mov output.mov     (reads only the box headers + moov)
// Also exported: describeFile(path) -> [[key, value]], compareTable(a, b) -> markdown.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const u32 = (b, o) => b.readUInt32BE(o);
function topBoxes(fd, size) {
  const out = []; let off = 0;
  while (off + 8 <= size) {
    const h = Buffer.alloc(16); readSync(fd, h, 0, 16, off);
    let sz = u32(h, 0); const t = h.toString('latin1', 4, 8);
    if (sz === 1) sz = Number(h.readBigUInt64BE(8)); else if (sz === 0) sz = size - off;
    if (sz < 8) break;
    out.push({ type: t, off, size: sz }); off += sz;
  }
  return out;
}
function kids(b, s, e) {
  const out = []; let p = s;
  while (p + 8 <= e) { let sz = u32(b, p), h = 8; const t = b.toString('latin1', p + 4, p + 8); if (sz === 1) { sz = Number(b.readBigUInt64BE(p + 8)); h = 16; } if (sz < 8 || p + sz > e) break; out.push({ type: t, start: p, end: p + sz, hdr: h }); p += sz; }
  return out;
}
const pay = (x) => x.start + x.hdr;
const find = (b, box, t) => kids(b, pay(box), box.end).find((k) => k.type === t);
const names = (b, box, off = 0) => kids(b, pay(box) + off, box.end).map((k) => k.type).join(' ');
function hdlrDesc(b, h) { const p = pay(h); const raw = b.subarray(p + 24, h.end); const nm = raw.length && raw[0] === raw.length - 1 ? raw.toString('latin1', 1) : raw.toString('latin1').replace(/\0+$/, ''); return `${b.toString('latin1', p + 4, p + 8).replace(/\0/g, '·')}/${b.toString('latin1', p + 8, p + 12)}/${b.toString('latin1', p + 12, p + 16).replace(/\0/g, '·')} «${nm}»${raw.length && raw[0] === raw.length - 1 ? ' (Pascal)' : ' (C)'}`; }

export function describeFile(path) {
  const fd = openSync(path, 'r'), size = fstatSync(fd).size, rows = [];
  const top = topBoxes(fd, size);
  rows.push(['file: box di primo livello', top.map((t) => t.type).join(' ')]);
  const ft = top.find((t) => t.type === 'ftyp');
  if (ft) { const b = Buffer.alloc(ft.size); readSync(fd, b, 0, ft.size, ft.off); const n = (ft.size - 16) / 4; rows.push(['ftyp', `major '${b.toString('latin1', 8, 12)}' minor ${u32(b, 12)} compat ${Array.from({ length: n }, (_, i) => `'${b.toString('latin1', 16 + 4 * i, 20 + 4 * i)}'`).join(',')}`]); }
  rows.push(['mdat', top.filter((t) => t.type === 'mdat').length + ' (' + top.filter((t) => t.type === 'mdat').map((t) => t.size > 4294967295 ? '64 bit' : '32 bit').join(', ') + ')']);
  const mv = top.find((t) => t.type === 'moov');
  const b = Buffer.alloc(mv.size); readSync(fd, b, 0, mv.size, mv.off); closeSync(fd);
  const root = { type: 'moov', start: 0, end: b.length, hdr: 8 };
  rows.push(['moov: figli', names(b, root)]);
  const mvhd = find(b, root, 'mvhd'), mp = pay(mvhd), mvv = b[mp];
  rows.push(['mvhd', `v${mvv} timescale ${u32(b, mp + (mvv ? 20 : 12))} next_track_ID ${u32(b, mp + (mvv ? 108 : 96))}`]);
  const meta = find(b, root, 'meta');
  if (meta) { const qt = b.toString('latin1', pay(meta) + 4, pay(meta) + 8) === 'hdlr'; rows.push(['moov/meta', `${qt ? 'QuickTime (senza version/flags)' : 'ISO full box'}: ${names(b, meta, qt ? 0 : 4)}`]); }
  kids(b, 8, b.length).filter((k) => k.type === 'trak').forEach((tr, i) => {
    const tk = find(b, tr, 'tkhd'), p = pay(tk), v = b[p];
    const mdia = find(b, tr, 'mdia'), minf = find(b, mdia, 'minf'), stbl = find(b, minf, 'stbl'), stsd = find(b, stbl, 'stsd');
    const ent = kids(b, pay(stsd) + 8, stsd.end)[0];
    const sub = b.toString('latin1', pay(find(b, mdia, 'hdlr')) + 8, pay(find(b, mdia, 'hdlr')) + 12);
    const K = `trak ${i + 1}`;
    const tref = find(b, tr, 'tref');
    rows.push([`${K}: tkhd`, `${ent.type} · v${v} ID ${u32(b, p + (v ? 20 : 12))} flags 0x${b.readUIntBE(p + 1, 3).toString(16)} alt ${b.readUInt16BE(p + (v ? 46 : 34))}${sub === 'vide' ? ` ${u32(b, tk.end - 8) / 65536}×${u32(b, tk.end - 4) / 65536}` : ''}`]);
    rows.push([`${K}: figli`, names(b, tr)]);
    if (tref) rows.push([`${K}: tref`, kids(b, pay(tref), tref.end).map((r) => `${r.type}→${Array.from({ length: (r.end - pay(r)) / 4 }, (_, j) => u32(b, pay(r) + 4 * j)).join(',')}`).join(' ')]);
    const md = find(b, mdia, 'mdhd'), mdp = pay(md);
    rows.push([`${K}: mdia`, `${names(b, mdia)} · mdhd v${b[mdp]} timescale ${u32(b, mdp + (b[mdp] ? 20 : 12))}`]);
    rows.push([`${K}: mdia/hdlr`, hdlrDesc(b, find(b, mdia, 'hdlr'))]);
    const dh = find(b, minf, 'hdlr'), dinf = find(b, minf, 'dinf'), dref = dinf && find(b, dinf, 'dref');
    rows.push([`${K}: minf`, `${names(b, minf)}${dh ? ' · ' + hdlrDesc(b, dh) : ''}${dref ? ' · dref ' + kids(b, pay(dref) + 8, dref.end).map((x) => `${x.type.trim()} fl${b[pay(x) + 3]}`).join(',') : ''}`]);
    const ep = pay(ent); let ed = '';
    if (['hvc1', 'hev1', 'avc1'].includes(ent.type)) { ed = `${b.readUInt16BE(ep + 24)}×${b.readUInt16BE(ep + 26)} quality ${u32(b, ep + 16)}/${u32(b, ep + 20)} «${b.toString('latin1', ep + 43, ep + 43 + b[ep + 42])}» · ${names(b, ent, 78)}`; const colr = kids(b, ep + 78, ent.end).find((k) => k.type === 'colr'); if (colr) { const c = pay(colr); ed += ` · colr ${b.toString('latin1', c, c + 4)} ${b.readUInt16BE(c + 4)}/${b.readUInt16BE(c + 6)}/${b.readUInt16BE(c + 8)}${b.toString('latin1', c, c + 4) === 'nclx' ? ' full_range ' + (b[c + 10] >> 7) : ''}`; } }
    else if (['mp4a', 'apac'].includes(ent.type)) { const sv = b.readUInt16BE(ep + 8); ed = `SoundDescription v${sv} · ${names(b, ent, 28 + (sv === 1 ? 16 : sv === 2 ? 36 : 0))}`; }
    else if (ent.type === 'mebx') ed = names(b, ent, 8);
    rows.push([`${K}: stsd/${ent.type}`, ed]);
    rows.push([`${K}: stbl`, names(b, stbl)]);
  });
  return rows;
}
export function compareTable(a, b, la = 'originale', lb = 'uscita') {
  const A = describeFile(a), B = describeFile(b), keys = [...new Set([...A.map((r) => r[0]), ...B.map((r) => r[0])])];
  const get = (R, k) => R.find((r) => r[0] === k)?.[1] ?? '—';
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  return [`| box | ${la} | ${lb} | = |`, '|---|---|---|---|', ...keys.map((k) => { const x = get(A, k), y = get(B, k); return `| ${esc(k)} | ${esc(x)} | ${esc(y)} | ${x === y ? '=' : '≠'} |`; })].join('\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , a, b] = process.argv;
  if (!a || !b) { console.error('uso: node tools/lab/box-compare.mjs originale.mov uscita.mov'); process.exit(2); }
  console.log(compareTable(a, b));
}
