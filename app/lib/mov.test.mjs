// Run: node app/lib/mov.test.mjs   (needs ffmpeg/ffprobe with libx265). Sources: samples/IMG_2147.mov (repo) and a private 4K
// iPhone file (APAC_PRIVATE or the default upload path, never copied into the repo). Missing files -> SKIP.
//
// v0.34: output container QuickTime MOV (default) vs MP4. Emulates the whole app pipeline with the REAL Mediabunny muxer:
//   x265 10-bit HLG + AAC copied (stand-in for the WebCodecs packets) -> Mediabunny MovOutputFormat / Mp4OutputFormat
//   (fastStart:false, metadataFormat 'mdta', BufferTarget) -> rewriteMoov(finishMoov: source metadata, dvvC, strings,
//   alignToQuickTime for MOV) -> ftyp from the source (MOV) -> second mdat with apac + every mebx copied byte for byte
//   -> addPassthroughTracks (track_IDs and trak order IDENTICAL to the source).
// Checks (ffprobe): format/brand, hvc1 Main 10 HLG bt2020 + DOVI record (profile 8, compat 4), AAC, apac and all mebx with
// identical per-packet SHA-256, AAC packets identical, trak order/IDs/tref/next_track_ID as in the source, hvc1 children
// in the source order, clean decode. MOV_TABLE=1 prints the box comparison table (tools/lab/box-compare.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, openSync, readSync, writeSync, fstatSync, ftruncateSync, closeSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as MB from '../../vendor/mediabunny-1.65.1.min.mjs';
import { locateMoov, parseBoxes, childBoxes, extractDoviConfigBox, findBox, videoTrak } from './dovi.js';
import { rewriteMoov, finishMoov, sourceFtypPatch } from './mp4-post.js';
import { listTracks } from './apac.js';
import { readPassthrough, selectPassthrough, planPassthroughMdat, copyPassthroughData, addPassthroughTracks, readTref, describeAdded } from './passthrough.js';
import { compareTable } from '../../tools/lab/box-compare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRIVATE = process.env.APAC_PRIVATE || '/root/.claude/uploads/41829d04-493e-5956-8e38-1bd70ab69d5c/5a829807-IMG_2790.mov';
const SOURCES = [join(ROOT, 'samples', 'IMG_2147.mov'), PRIVATE];
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }); assert.equal(r.status, 0, cmd + ' ' + args.join(' ') + '\n' + r.stderr); return { out: r.stdout, err: r.stderr }; };
const probe = (f, args) => JSON.parse(run('ffprobe', ['-v', 'error', '-of', 'json', ...args, f]).out);
function fileReader(path) {
  const fd = openSync(path, 'r'); const size = fstatSync(fd).size;
  return { fd, size, read: async (o, l) => { const b = Buffer.alloc(Math.max(0, Math.min(l, size - o))); readSync(fd, b, 0, b.length, o); return new Uint8Array(b.buffer, b.byteOffset, b.length); } };
}
const pktHashes = (f, idx) => run('ffprobe', ['-v', 'error', '-select_streams', String(idx), '-show_data_hash', 'sha256', '-show_entries', 'packet=size,data_hash', '-of', 'csv=p=0', f]).out.trim().split('\n');
const traksOf = (moov) => childBoxes(moov, parseBoxes(moov)[0]).filter((b) => b.type === 'trak');
const nextId = (moov) => { const m = parseBoxes(moov)[0]; const mh = childBoxes(moov, m).find((b) => b.type === 'mvhd'); const p = mh.start + 8; return new DataView(moov.buffer, moov.byteOffset).getUint32(p + (moov[p] === 1 ? 108 : 96)); };

/** Mediabunny mux of enc.mp4 (video + AAC packets, unchanged) into MOV or MP4, moov at the end. */
async function mediabunnyMux(encPath, container) {
  const input = new MB.Input({ source: new MB.BufferSource(readFileSync(encPath)), formats: MB.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack(), at = await input.getPrimaryAudioTrack();
  const target = new MB.BufferTarget();
  const opts = { fastStart: false, metadataFormat: 'mdta' };
  const output = new MB.Output({ format: container === 'mov' ? new MB.MovOutputFormat(opts) : new MB.Mp4OutputFormat(opts), target });
  const vs = new MB.EncodedVideoPacketSource('hevc'); output.addVideoTrack(vs);
  const as = new MB.EncodedAudioPacketSource('aac'); output.addAudioTrack(as);
  output.setMetadataTags({ raw: { 'com.apple.quicktime.make': 'WRONG' }, creationTime: new Date(0) });
  await output.start();
  const vc = await vt.getDecoderConfig(); let first = true;
  for await (const p of new MB.EncodedPacketSink(vt).packets()) { await vs.add(p, first ? { decoderConfig: vc } : undefined); first = false; }
  const ac = await at.getDecoderConfig(); first = true;
  for await (const p of new MB.EncodedPacketSink(at).packets()) { if (p.timestamp < 0) continue; await as.add(p, first ? { decoderConfig: ac } : undefined); first = false; }
  vs.close(); as.close(); await output.finalize();
  return new Uint8Array(target.buffer);
}

const encCache = new Map();
async function build(src, outPath, { container, audioCopied = true }) {
  const s = fileReader(src);
  const loc = await locateMoov(s.read, s.size); const srcMoov = (await s.read(loc.offset, loc.size)).slice();
  const srcHead = (await s.read(0, 64)).slice();
  if (!encCache.has(src)) {
    const tmp = mkdtempSync(join(tmpdir(), 'mov-enc-'));
    const aacIdx = probe(src, ['-show_entries', 'stream=index,codec_name']).streams.find((x) => x.codec_name === 'aac').index;
    const enc = join(tmp, 'enc.mp4');
    run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', `0:${aacIdx}`, '-vf', 'scale=-2:360', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'ultrafast',
      '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error', '-tag:v', 'hvc1', '-c:a', 'copy', enc]);
    encCache.set(src, { enc, tmp });
  }
  const file = await mediabunnyMux(encCache.get(src).enc, container);
  writeFileSync(outPath, file);
  const o = fileReader(outPath);
  let changes = [];
  const { prefixLength, moov } = await rewriteMoov({ size: o.size, read: o.read }, (m) => {
    const r = finishMoov(srcMoov, m, { dvBox: extractDoviConfigBox(srcMoov), quickTime: container === 'mov', audioCopied, strings: { 'com.apple.quicktime.displayname': 'test · mov', 'com.apple.quicktime.description': 'finally-compress-video test' } });
    changes = r.changes; return r.moov;
  });
  closeSync(o.fd);
  const fd = openSync(outPath, 'r+');
  if (container === 'mov') { const head = Buffer.alloc(64); readSync(fd, head, 0, 64, 0); const ft = sourceFtypPatch(srcHead, new Uint8Array(head)); if (ft) writeSync(fd, ft, 0, ft.length, 0); }
  const info = readPassthrough(srcMoov); assert.equal(info.errors.length, 0, JSON.stringify(info.errors));
  const sel = selectPassthrough(info, { apac: true, meta: true, aacOut: true });
  ftruncateSync(fd, prefixLength);
  const plan = planPassthroughMdat(sel.tracks, prefixLength);
  writeSync(fd, plan.header, 0, plan.header.length, prefixLength);
  await copyPassthroughData(plan, { read: s.read, write: async (p, u8) => { writeSync(fd, u8, 0, u8.length, p); }, blockSize: 256 * 1024 });
  const r = addPassthroughTracks(moov, info, sel.tracks, { chunkOffsets: plan.chunkOffsets });
  writeSync(fd, r.moov, 0, r.moov.length, prefixLength + plan.size);
  closeSync(fd); closeSync(s.fd);
  return { srcMoov, info, sel, r, outMoov: r.moov, changes };
}

let ran = 0;
const tables = [];
for (const src of SOURCES) {
  if (!existsSync(src)) { console.log('SKIP (file mancante): ' + src); continue; }
  const variants = [{ container: 'mov' }, { container: 'mp4' }];
  if (src.endsWith('IMG_2147.mov')) variants.push({ container: 'mov', audioCopied: false });
  for (const v of variants) {
    const dir = mkdtempSync(join(tmpdir(), 'mov-out-')), out = join(dir, 'out.' + v.container);
    const { srcMoov, info, sel, r, outMoov, changes } = await build(src, out, v);
    const name = `${src.split('/').pop()} [${v.container}${v.audioCopied === false ? ', stsd AAC con esds nuovo' : ''}]`;
    // 1. container
    const fmt = probe(out, ['-show_entries', 'format=format_name,duration:format_tags=major_brand']).format;
    assert.match(fmt.format_name, /mov/);
    assert.equal(fmt.tags?.major_brand?.trim(), v.container === 'mov' ? 'qt' : 'isom', name + ': major brand');
    // 2. video: hvc1 Main 10 HLG bt2020 + DOVI configuration record
    const S = probe(src, ['-show_streams']).streams, O = probe(out, ['-show_streams']).streams;
    const vo = O.find((x) => x.codec_type === 'video');
    assert.equal(vo.codec_name, 'hevc'); assert.equal(vo.codec_tag_string, 'hvc1'); assert.equal(vo.profile, 'Main 10');
    assert.equal(vo.color_transfer, 'arib-std-b67'); assert.equal(vo.color_primaries, 'bt2020'); assert.equal(vo.color_space, 'bt2020nc');
    const dovi = (vo.side_data_list || []).find((d) => /DOVI/i.test(d.side_data_type));
    assert.ok(dovi, name + ': DOVI configuration record'); assert.equal(dovi.dv_profile, 8); assert.equal(dovi.dv_bl_signal_compatibility_id, 4);
    // 3. traks: same order, same track_ID, same entries, same tref, same next_track_ID as the source
    const sT = listTracks(srcMoov), oT = listTracks(outMoov);
    assert.deepEqual(oT.map((t) => [t.trackId, t.entry]), sT.map((t) => [t.trackId, t.entry]), name + ': ordine/ID dei trak come la sorgente');
    assert.deepEqual(traksOf(outMoov).map((t) => readTref(outMoov, t)), traksOf(srcMoov).map((t) => readTref(srcMoov, t)), name + ': tref identici');
    assert.equal(nextId(outMoov), nextId(srcMoov), name + ': next_track_ID');
    oT.forEach((t, i) => { if (t.entry !== 'hvc1') { assert.equal(t.flags, sT[i].flags, `${name}: flags ${t.entry}`); assert.equal(t.alternateGroup, sT[i].alternateGroup, `${name}: alt ${t.entry}`); } });
    assert.equal(O.length, S.length, name + ': numero di stream');
    // 4. copied tracks (apac + every mebx) and AAC: identical per-packet bytes
    const nMeta = sT.filter((t) => t.entry === 'mebx').length;
    assert.equal(sel.tracks.length, nMeta + 1, name + ': apac + tutte le mebx');
    for (let i = 0; i < sT.length; i++) {
      if (sT[i].entry === 'hvc1') continue;
      assert.equal(O[i].codec_tag_string, S[i].codec_tag_string, `${name}: stream ${i}`);
      const hO = pktHashes(out, i); let hS = pktHashes(src, i);
      // AAC: the app (and this test) drops the packets with negative timestamps (priming, 2-3 packets): the rest is identical
      if (sT[i].entry === 'mp4a') { assert.ok(hO.length >= hS.length - 4 && hO.length <= hS.length, `${name}: pacchetti AAC ${hO.length}/${hS.length}`); hS = hS.slice(hS.length - hO.length); }
      assert.deepEqual(hO, hS, `${name}: pacchetti dello stream ${i} (${sT[i].entry}) diversi`);
    }
    // 5. MOV: hvc1 children in the source order, QuickTime handlers
    if (v.container === 'mov') {
      const kidsOfEntry = (m) => { const sd = findBox(m, ['moov', videoTrak, 'mdia', 'minf', 'stbl', 'stsd']); return childBoxes(m, childBoxes(m, sd)[0]).map((b) => b.type); };
      assert.deepEqual(kidsOfEntry(outMoov), kidsOfEntry(srcMoov), name + ': figli di hvc1');
      const hd = (m, t) => { const h = findBox(m, ['mdia', 'hdlr'], t.start + 8, t.end); return Buffer.from(m.subarray(h.start, h.end)).toString('hex'); };
      traksOf(outMoov).forEach((t, i) => assert.equal(hd(outMoov, t), hd(srcMoov, traksOf(srcMoov)[i]), `${name}: hdlr trak ${i + 1}`));
      const ft = Buffer.alloc(20); const fd = openSync(out, 'r'); readSync(fd, ft, 0, 20, 0); closeSync(fd);
      assert.equal(ft.toString('latin1', 8, 12), 'qt  ');
    }
    // 6. clean decode (video + every audio track ffmpeg can decode: AAC; apac has no decoder in ffmpeg)
    const aacI = O.findIndex((x) => x.codec_name === 'aac');
    const dec = run('ffmpeg', ['-v', 'error', '-i', out, '-map', '0:v:0', '-map', `0:${aacI}`, '-f', 'null', '-']);
    assert.equal(dec.err.trim(), '', name + ': errori di decodifica:\n' + dec.err);
    const dOut = +fmt.duration, dSrc = +probe(src, ['-show_entries', 'format=duration']).format.duration;
    assert.ok(Math.abs(dOut - dSrc) < 0.1, `${name}: durata ${dOut} vs ${dSrc}`);
    console.log(`ok ${name}: ${fmt.format_name} brand ${fmt.tags.major_brand.trim()} · ${r.added.map(describeAdded).join(' · ')} · ${changes.join('; ') || 'nessun allineamento QuickTime'}`);
    if (v.container === 'mov' && v.audioCopied !== false) tables.push(`### ${src.split('/').pop()}\n\n${compareTable(src, out, 'originale iPhone', 'uscita MOV')}`);
    rmSync(dir, { recursive: true, force: true });
    ran++;
  }
}
for (const { tmp } of encCache.values()) rmSync(tmp, { recursive: true, force: true });
if (process.env.MOV_TABLE) console.log('\n' + tables.join('\n\n'));
console.log(ran ? `mov: ${ran} uscite OK` : 'SKIP: nessun file sorgente');
