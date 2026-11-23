// Run: node app/lib/passthrough.test.mjs   (needs ffmpeg/ffprobe with libx265). Sources: samples/IMG_2147.mov (repo) and a
// private 4K iPhone file (APAC_PRIVATE or the default upload path, never copied into the repo). Missing files -> SKIP.
//
// Emulates the app: "Mediabunny-like" output (x265 + AAC copied, moov at the end) -> rewriteMoov(copySourceMetadata) ->
// truncate at prefixLength -> ONE second mdat with the apac + mebx chunks streamed from the source -> moov + copied traks.
// Checks: ffprobe lists apac + every mebx; for each copied track same packet count and identical per-packet SHA-256;
// tref remapped (cinematic-audio cdsc -> new apac ID, cdep/cdsc/rndr -> output video, fall -> output AAC);
// tkhd flags/alternate_group as in the source; decodable; coherent duration. Also: no apac (audio repaired) -> the
// cinematic-audio track is skipped, the video mebx are still copied.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, readSync, writeSync, fstatSync, ftruncateSync, closeSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateMoov, parseBoxes, childBoxes } from './dovi.js';
import { copySourceMetadata, rewriteMoov } from './mp4-post.js';
import { listTracks } from './apac.js';
import { readPassthrough, selectPassthrough, planPassthroughMdat, copyPassthroughData, addPassthroughTracks, readTref, describeAdded } from './passthrough.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRIVATE = process.env.APAC_PRIVATE || '/root/.claude/uploads/41829d04-493e-5956-8e38-1bd70ab69d5c/5a829807-IMG_2790.mov';
const SOURCES = [join(ROOT, 'samples', 'IMG_2147.mov'), PRIVATE];
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }); assert.equal(r.status, 0, cmd + ' ' + args.join(' ') + '\n' + r.stderr); return r.stdout; };
const probe = (f, args) => JSON.parse(run('ffprobe', ['-v', 'error', '-of', 'json', ...args, f]));
function fileReader(path) {
  const fd = openSync(path, 'r'); const size = fstatSync(fd).size;
  return { fd, size, read: async (o, l) => { const b = Buffer.alloc(Math.max(0, Math.min(l, size - o))); readSync(fd, b, 0, b.length, o); return new Uint8Array(b.buffer, b.byteOffset, b.length); } };
}
const pktHashes = (f, idx) => run('ffprobe', ['-v', 'error', '-select_streams', String(idx), '-show_data_hash', 'sha256', '-show_entries', 'packet=size,data_hash', '-of', 'csv=p=0', f]).trim().split('\n');
const trefsOf = (moov) => { const root = parseBoxes(moov)[0]; return childBoxes(moov, root).filter((b) => b.type === 'trak').map((t) => readTref(moov, t)); };

async function transplant(src, outPath, { co64 = null, apac = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'pt-'));
  const s = fileReader(src);
  const loc = await locateMoov(s.read, s.size); const srcMoov = (await s.read(loc.offset, loc.size)).slice();
  const info = readPassthrough(srcMoov); assert.equal(info.errors.length, 0, JSON.stringify(info.errors));
  const streams = probe(src, ['-show_entries', 'stream=index,codec_name']).streams;
  const aacIdx = streams.find((x) => x.codec_name === 'aac').index;
  const base = join(tmp, 'mb.mp4');
  run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', `0:${aacIdx}`, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-vf', 'scale=-2:360', '-tag:v', 'hvc1', '-c:a', 'copy', base]);
  copyFileSync(base, outPath);
  const o = fileReader(outPath);
  const { prefixLength, moov } = await rewriteMoov({ size: o.size, read: o.read }, (m) => copySourceMetadata(srcMoov, m));
  closeSync(o.fd);
  const sel = selectPassthrough(info, { apac, meta: true, aacOut: true });
  const fd = openSync(outPath, 'r+');
  ftruncateSync(fd, prefixLength);
  const plan = planPassthroughMdat(sel.tracks, prefixLength);
  writeSync(fd, plan.header, 0, plan.header.length, prefixLength);
  const n = await copyPassthroughData(plan, { read: s.read, write: async (p, u8) => { writeSync(fd, u8, 0, u8.length, p); }, blockSize: 64 * 1024 });
  assert.equal(n, plan.totalBytes);
  const r = addPassthroughTracks(moov, info, sel.tracks, { chunkOffsets: plan.chunkOffsets, co64 });
  writeSync(fd, r.moov, 0, r.moov.length, prefixLength + plan.size);
  closeSync(fd); closeSync(s.fd); rmSync(tmp, { recursive: true, force: true });
  return { srcMoov, info, sel, r, plan, outMoov: r.moov };
}

let ran = 0;
for (const src of SOURCES) {
  if (!existsSync(src)) { console.log('SKIP (file mancante): ' + src); continue; }
  for (const variant of [{}, { co64: true }, { apac: false }]) {
    const out = join(mkdtempSync(join(tmpdir(), 'pt-out-')), 'out.mp4');
    const { srcMoov, info, sel, r, outMoov } = await transplant(src, out, variant);
    const name = src.split('/').pop() + (variant.co64 ? ' [co64]' : variant.apac === false ? ' [senza apac]' : '');
    const sT = listTracks(srcMoov), oT = listTracks(outMoov), sRef = trefsOf(srcMoov), oRef = trefsOf(outMoov);
    const nMeta = sT.filter((t) => t.entry === 'mebx').length;
    assert.ok(nMeta > 0, name + ': mebx attese nella sorgente');
    const cine = info.meta.find((m) => m.keys.some((k) => /cinematic-audio/.test(k)));
    if (variant.apac === false) {
      assert.ok(!sel.tracks.some((t) => t.entry === 'apac'));
      if (cine) assert.ok(sel.skipped.some((x) => x.track === cine), name + ': cinematic-audio senza apac va saltata');
      assert.equal(sel.tracks.length, nMeta - (cine ? 1 : 0));
    } else assert.equal(sel.tracks.length, nMeta + 1, name + ': apac + tutte le mebx');
    // 1. ffprobe: every copied track is there, same packet count and identical per-packet bytes
    const S = probe(src, ['-show_entries', 'stream=index,codec_tag_string,nb_frames,duration']).streams;
    const O = probe(out, ['-show_entries', 'stream=index,codec_tag_string,nb_frames,duration']).streams;
    assert.equal(O.length, 2 + sel.tracks.length, name + ': numero di stream');
    for (const a of r.added) {
      const si = sT.findIndex((t) => t.trackId === a.srcId), oi = oT.findIndex((t) => t.trackId === a.outId);
      const ss = S[si], os = O[oi]; // ffprobe stream index = trak order
      assert.equal(os.codec_tag_string, a.entry, `${name}: stream ${oi} = ${a.entry}`);
      assert.equal(+os.nb_frames, +ss.nb_frames, `${name}: pacchetti ${a.label}`);
      assert.equal(+os.nb_frames, sel.tracks.find((t) => t.trackId === a.srcId).sampleCount);
      const hO = pktHashes(out, oi), hS = pktHashes(src, si);
      assert.equal(hO.length, hS.length); assert.deepEqual(hO, hS, `${name}: byte dei pacchetti ${a.label} diversi`);
      if (ss.duration && os.duration) assert.ok(Math.abs(+os.duration - +ss.duration) < 0.002, `${name}: durata ${a.label} ${os.duration} vs ${ss.duration}`);
      // 2. flags / alternate_group as in the source
      assert.equal(oT[oi].flags, sT[si].flags, `${name}: flags ${a.label}`); assert.equal(oT[oi].alternateGroup, sT[si].alternateGroup, `${name}: alternate_group ${a.label}`);
      // 3. tref remapped: same types, each target = image of the source target
      const vSrc = sT.find((t) => t.handler === 'vide').trackId, vOut = oT.find((t) => t.handler === 'vide').trackId;
      const aSrc = info.aac.trackId, aOut = oT.find((t) => t.entry === 'mp4a').trackId;
      const expect = sRef[si].map((x) => ({ type: x.type, ids: x.ids.map((id) => (id === vSrc ? vOut : id === aSrc ? aOut : r.idMap.get(id))) }));
      assert.deepEqual(oRef[oi], expect, `${name}: tref ${a.label}`);
      for (const x of oRef[oi]) for (const id of x.ids) assert.ok(oT.some((t) => t.trackId === id), `${name}: ${a.label} ${x.type}→${id} inesistente`);
    }
    if (cine && variant.apac !== false) {
      const c = r.added.find((a) => a.srcId === cine.trackId), ap = r.added.find((a) => a.entry === 'apac');
      assert.deepEqual(c.tref, [{ type: 'cdsc', ids: [ap.outId] }], name + ': cinematic-audio cdsc → nuova apac');
    }
    if (variant.apac !== false) {
      const sAac = sT.find((t) => t.entry === 'mp4a'), oAac = oT.find((t) => t.entry === 'mp4a');
      assert.equal(oAac.flags, sAac.flags, name + ': flags AAC'); assert.equal(oAac.alternateGroup, sAac.alternateGroup);
    }
    assert.equal(new Set(oT.map((t) => t.trackId)).size, oT.length, 'track_ID univoci');
    const mvNext = (() => { const m = parseBoxes(outMoov)[0]; const mh = childBoxes(outMoov, m).find((b) => b.type === 'mvhd'); const p = mh.start + 8; return new DataView(outMoov.buffer, outMoov.byteOffset).getUint32(p + (outMoov[p] === 1 ? 108 : 96)); })();
    assert.equal(mvNext, Math.max(...oT.map((t) => t.trackId)) + 1, 'mvhd.next_track_ID');
    // 4. decodable (video + AAC), coherent duration, still a valid "moov last" file
    run('ffmpeg', ['-v', 'error', '-i', out, '-map', '0:v', '-map', '0:a:0', '-f', 'null', '-']);
    const dOut = +probe(out, ['-show_entries', 'format=duration']).format.duration, dSrc = +probe(src, ['-show_entries', 'format=duration']).format.duration;
    assert.ok(Math.abs(dOut - dSrc) < 0.1, `${name}: durata ${dOut} vs ${dSrc}`);
    const fo = fileReader(out); await rewriteMoov({ size: fo.size, read: fo.read }, (m) => m); closeSync(fo.fd);
    if (variant.co64) assert.ok(Buffer.from(outMoov).includes(Buffer.from('co64')));
    console.log(`ok ${name}: ${r.added.map(describeAdded).join(' · ')}${sel.skipped.length ? ' · saltate: ' + sel.skipped.map((x) => x.track.label).join(', ') : ''} · durata ${dOut.toFixed(3)} s`);
    rmSync(dirname(out), { recursive: true, force: true });
    ran++;
  }
}
// unit: selection rules on a synthetic info (no apac in output -> cinematic-audio skipped; mebx -> mebx chains)
{
  const T = (trackId, entry, tref = [], keys = []) => ({ trackId, entry, keys, label: keys[0] || entry, tref, chunks: [], tkhd: {} });
  const info = { video: { trackId: 1 }, aac: { trackId: 2 }, apac: T(3, 'apac', [{ type: 'fall', ids: [2] }]),
    meta: [T(5, 'mebx', [{ type: 'cdsc', ids: [3] }], ['cinematic-audio']), T(4, 'mebx', [{ type: 'cdsc', ids: [1] }]), T(6, 'mebx', [{ type: 'cdsc', ids: [5] }]), T(7, 'mebx', [{ type: 'rndr', ids: [9] }])] };
  let s = selectPassthrough(info, { apac: true });
  assert.deepEqual(s.tracks.map((t) => t.trackId), [3, 4, 5, 6]); assert.deepEqual(s.skipped.map((x) => x.track.trackId), [7]);
  s = selectPassthrough(info, { apac: false });
  assert.deepEqual(s.tracks.map((t) => t.trackId), [4]); assert.deepEqual(s.skipped.map((x) => x.track.trackId).sort(), [3, 5, 6, 7]);
  s = selectPassthrough(info, { apac: true, aacOut: false }); assert.ok(s.tracks.some((t) => t.trackId === 3), 'fall verso AAC assente non blocca apac');
  console.log('ok selectPassthrough');
}
console.log(ran ? `passthrough: ${ran} trapianti OK` : 'SKIP: nessun file sorgente');
