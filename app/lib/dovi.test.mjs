// Run: node app/lib/dovi.test.mjs   (needs /usr/bin/ffmpeg + ffprobe with libx265; reads IMG_7440.mov / IMG_2147.mov in repo root)
//
// Pipeline emulated here (Node rebuilds the whole file for the test):
//   source .mov -> locateMoov -> dvvC + per-frame RPUs (NAL 62) -> ffmpeg x265 10-bit HLG (moov at the end,
//   like Mediabunny fastStart:false) -> appendNals(RPU of the source frame with same presentation index)
//   -> new mdat + patched stsz/stco -> insertIntoVideoSampleEntry + copySourceMetadata on the moov.
// In the BROWSER the RPU is appended in the encoder output callback BEFORE muxing, so mdat is never rewritten
// and only the final moov is replaced (rewriteMoov: Blob([blob.slice(0, prefixLength), moov])).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, openSync, readSync, fstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNals, appendNals, locateMoov, extractDoviConfigBox, findBox, parseBoxes, childBoxes, boxBytes, videoTrak } from './dovi.js';
import { insertIntoVideoSampleEntry, moveUdtaMetaToMoov, copySourceMetadata, rewriteMoov } from './mp4-post.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'dovi-'));
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32 = (b, o) => u32(b, o) | 0;
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }); assert.equal(r.status, 0, cmd + ' ' + args.join(' ') + '\n' + r.stderr); return r.stdout + r.stderr; };

// file-backed read(offset,len) like File.slice().arrayBuffer()
function fileReader(path) {
  const fd = openSync(path, 'r'); const size = fstatSync(fd).size;
  return { size, read: async (o, l) => { const b = Buffer.alloc(Math.min(l, size - o)); readSync(fd, b, 0, b.length, o); return new Uint8Array(b.buffer, b.byteOffset, b.length); } };
}

// ---- sample table of the video track ----
function sampleTable(moov) {
  const stbl = findBox(moov, ['moov', videoTrak, 'mdia', 'minf', 'stbl']);
  const kid = (t) => { const b = childBoxes(moov, stbl).find((x) => x.type === t); return b && { b, o: b.start + b.hdr }; };
  const stsz = kid('stsz'), stsc = kid('stsc'), stts = kid('stts'), ctts = kid('ctts'), stco = kid('stco') || kid('co64');
  const n = u32(moov, stsz.o + 8);
  const sizes = Array.from({ length: n }, (_, i) => (u32(moov, stsz.o + 4) ? u32(moov, stsz.o + 4) : u32(moov, stsz.o + 12 + 4 * i)));
  const nch = u32(moov, stco.o + 4), co64 = stco.b.type === 'co64';
  const chunkOff = Array.from({ length: nch }, (_, i) => (co64 ? u32(moov, stco.o + 8 + 8 * i) * 2 ** 32 + u32(moov, stco.o + 12 + 8 * i) : u32(moov, stco.o + 8 + 4 * i)));
  const sc = Array.from({ length: u32(moov, stsc.o + 4) }, (_, i) => ({ first: u32(moov, stsc.o + 8 + 12 * i), n: u32(moov, stsc.o + 12 + 12 * i) }));
  const offsets = []; // per sample absolute offset
  let s = 0;
  for (let c = 0; c < nch; c++) {
    let per = 0; for (const e of sc) if (e.first <= c + 1) per = e.n;
    let o = chunkOff[c];
    for (let k = 0; k < per && s < n; k++, s++) { offsets.push(o); o += sizes[s]; }
  }
  const dts = []; let t = 0;
  for (let i = 0, e = u32(moov, stts.o + 4); i < e; i++) { const cnt = u32(moov, stts.o + 8 + 8 * i), d = u32(moov, stts.o + 12 + 8 * i); for (let k = 0; k < cnt; k++) { dts.push(t); t += d; } }
  const off = new Array(n).fill(0);
  if (ctts) for (let i = 0, e = u32(moov, ctts.o + 4), j = 0; i < e; i++) { const cnt = u32(moov, ctts.o + 8 + 8 * i), d = i32(moov, ctts.o + 12 + 8 * i); for (let k = 0; k < cnt; k++) off[j++] = d; }
  const pts = dts.map((d, i) => d + off[i]);
  // decode index at each presentation position
  const presOrder = [...pts.keys()].sort((a, b) => pts[a] - pts[b]);
  return { n, sizes, offsets, chunkOff, sc, pts, presOrder, stszO: stsz.o, stcoO: stco.o, co64 };
}
function lenSizeOf(moov) {
  const stsd = findBox(moov, ['moov', videoTrak, 'mdia', 'minf', 'stbl', 'stsd']);
  const e = childBoxes(moov, stsd)[0];
  const hvcC = childBoxes(moov, e).find((b) => b.type === 'hvcC');
  return (moov[hvcC.start + hvcC.hdr + 21] & 3) + 1;
}
const topChildren = (moov) => childBoxes(moov, parseBoxes(moov)[0]).map((b) => b.type);

// ---- 0. unit tests of NAL helpers ----
{
  const mk = (t, len) => { const n = new Uint8Array(len); n[0] = t << 1; n[1] = 1; return n; };
  const nals = [mk(1, 5), mk(62, 7), mk(39, 3)];
  const s = appendNals(new Uint8Array(0), nals, 4);
  assert.equal(extractNals(s, [62]).length, 1);
  assert.deepEqual(extractNals(s, [62])[0], nals[1]);
  const s2 = appendNals(s, [mk(62, 9)], 4);
  const all = extractNals(s2, [1, 62, 39]);
  assert.equal(all.length, 4);
  assert.equal((all[3][0] >> 1) & 63, 62); // RPU is last
  assert.deepEqual(extractNals(appendNals(new Uint8Array(0), [mk(62, 6)], 2), [62], 2)[0], mk(62, 6));
  console.log('ok nal helpers');
}

async function pipeline(name, nFramesMax = 120) {
  const srcPath = join(ROOT, name + '.mov');
  assert.ok(existsSync(srcPath), srcPath + ' missing');
  // 1. source moov / dvvC / RPUs
  const rd = fileReader(srcPath);
  const loc = await locateMoov(rd.read, rd.size);
  assert.ok(loc && loc.offset > 0);
  const srcMoov = await rd.read(loc.offset, loc.size);
  assert.equal(String.fromCharCode(...srcMoov.subarray(4, 8)), 'moov');
  const dv = extractDoviConfigBox(srcMoov);
  assert.ok(dv, 'dvcC/dvvC found');
  const dvType = String.fromCharCode(...dv.subarray(4, 8));
  assert.equal(dv.length, 32);
  assert.equal(dv[8], 1); // dv_version_major
  assert.equal(dv[10] >> 1, 8); // profile 8
  assert.equal(dv[12] >> 4, 4); // bl_signal_compatibility_id = 4 (HLG)
  const st = sampleTable(srcMoov), ls = lenSizeOf(srcMoov);
  const rpus = []; // by presentation index
  const rpuOfDecode = [];
  for (let i = 0; i < st.n; i++) {
    const s = await rd.read(st.offsets[i], st.sizes[i]);
    const r = extractNals(s, [62], ls);
    assert.equal(r.length, 1, 'one RPU per source sample (sample ' + i + ')');
    assert.equal(r[0][0], 0x7c); // NAL type 62
    rpuOfDecode.push(Uint8Array.from(r[0]));
  }
  for (const di of st.presOrder) rpus.push(rpuOfDecode[di]);
  console.log(`ok ${name}: ${dvType} found (${st.n} samples, RPUs ${rpus[0].length}B avg ${Math.round(rpus.reduce((a, r) => a + r.length, 0) / rpus.length)}B, lenSize ${ls})`);

  // 2. x265 10-bit HLG, moov at the end, metadata in udta/meta (mdta)
  const nFrames = Math.min(nFramesMax, st.n);
  const encPath = join(tmp, name + '-enc.mp4');
  run('ffmpeg', ['-v', 'error', '-y', '-i', srcPath, '-map', '0:v:0', '-frames:v', String(nFrames), '-vf', 'scale=640:-2', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-preset', 'ultrafast',
    '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error:bframes=3', '-tag:v', 'hvc1', '-an', '-movflags', 'use_metadata_tags',
    '-metadata', 'com.apple.quicktime.creationdate=1999-01-01T00:00:00+0000', '-metadata', 'com.apple.quicktime.model=WRONG', encPath]);
  const enc = new Uint8Array(readFileSync(encPath));
  const top = parseBoxes(enc);
  const mdatB = top.find((b) => b.type === 'mdat'), moovB = top.find((b) => b.type === 'moov');
  assert.ok(moovB.start > mdatB.start, 'ffmpeg output has moov after mdat');
  const encMoov = enc.slice(moovB.start, moovB.end);
  assert.ok(findBox(encMoov, ['moov', 'udta', 'meta']), 'encoder wrote moov/udta/meta');
  const et = sampleTable(encMoov);
  assert.equal(et.n, nFrames);

  // 3. graft RPUs by presentation index; rebuild mdat (test only) and patch stsz/stco in the moov
  const newSamples = new Array(et.n);
  et.presOrder.forEach((di, pi) => {
    newSamples[di] = appendNals(enc.subarray(et.offsets[di], et.offsets[di] + et.sizes[di]), [rpus[pi]], lenSizeOf(encMoov));
  });
  const mdatPayload = Buffer.concat(newSamples.map((s) => Buffer.from(s)));
  const head = enc.subarray(0, mdatB.start);
  const mdatHdr = Buffer.alloc(8); mdatHdr.writeUInt32BE(8 + mdatPayload.length, 0); mdatHdr.write('mdat', 4, 'latin1');
  assert.equal(mdatB.end - mdatB.start - 8, et.sizes.reduce((a, b) => a + b, 0), 'single contiguous mdat of video samples');
  const patched = encMoov.slice();
  const base = mdatB.start + 8;
  newSamples.forEach((s, i) => { const o = et.stszO + 12 + 4 * i; patched[o] = s.length >>> 24; patched[o + 1] = (s.length >> 16) & 255; patched[o + 2] = (s.length >> 8) & 255; patched[o + 3] = s.length & 255; });
  {
    let s = 0, off = base;
    for (let c = 0; c < et.chunkOff.length; c++) {
      let per = 0; for (const e of et.sc) if (e.first <= c + 1) per = e.n;
      assert.ok(!et.co64);
      patched[et.stcoO + 8 + 4 * c] = off >>> 24; patched[et.stcoO + 9 + 4 * c] = (off >> 16) & 255; patched[et.stcoO + 10 + 4 * c] = (off >> 8) & 255; patched[et.stcoO + 11 + 4 * c] = off & 255;
      for (let k = 0; k < per; k++, s++) off += newSamples[s].length;
    }
  }
  // 4. moov edits (the part that runs in the browser)
  let moov2 = insertIntoVideoSampleEntry(patched, dv);
  const hv = findBox(moov2, ['moov', videoTrak, 'mdia', 'minf', 'stbl', 'stsd']);
  const entry = childBoxes(moov2, hv)[0];
  assert.deepEqual(childBoxes(moov2, entry).map((b) => b.type).slice(0, 3), ['hvcC', dvType, childBoxes(moov2, entry)[2].type]);
  assert.deepEqual(extractDoviConfigBox(moov2), dv);
  moov2 = copySourceMetadata(srcMoov, moov2);
  assert.equal(findBox(moov2, ['moov', 'udta']), null, 'empty udta removed');
  const srcMeta = boxBytes(srcMoov, findBox(srcMoov, ['moov', 'meta']));
  assert.deepEqual(moov2.slice((m => m.start)(findBox(moov2, ['moov', 'meta'])), findBox(moov2, ['moov', 'meta']).end), srcMeta.slice(), 'moov/meta verbatim');
  const srcTm = findBox(srcMoov, ['moov', videoTrak, 'meta']);
  if (srcTm) {
    const ot = findBox(moov2, ['moov', videoTrak, 'meta']);
    assert.ok(ot, 'trak meta copied');
    assert.deepEqual(boxBytes(moov2, ot).slice(), boxBytes(srcMoov, srcTm).slice(), 'trak meta verbatim');
  }
  const outPath = join(tmp, name + '-dv.mp4');
  writeFileSync(outPath, Buffer.concat([head, mdatHdr, mdatPayload, moov2]));
  // browser-style helper must accept the result and be a no-op identity
  const rw = await rewriteMoov(new Uint8Array(readFileSync(outPath)), (m) => m);
  assert.equal(rw.prefixLength, head.length + 8 + mdatPayload.length);

  // 5. ffprobe / ffmpeg checks
  const streams = run('ffprobe', ['-v', 'error', '-show_streams', outPath]);
  assert.match(streams, /DOVI configuration record/);
  assert.match(streams, /dv_profile=8/);
  assert.match(streams, /dv_bl_signal_compatibility_id=4/);
  const frames = run('ffprobe', ['-v', 'error', '-show_frames', '-read_intervals', '%+#5', outPath]);
  assert.match(frames, /Dolby Vision (RPU Data|Metadata)|DOVI RPU/i);
  const nSide = (frames.match(/side_data_type=Dolby Vision RPU Data/g) || []).length;
  assert.ok(nSide >= 5, 'RPU side data on first 5 frames, got ' + nSide);
  assert.equal(run('ffmpeg', ['-v', 'error', '-i', outPath, '-f', 'null', '-']).trim(), '', 'clean decode');
  const tags = run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'default=nw=1', outPath]);
  const srcTags = run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'default=nw=1', srcPath]);
  for (const key of ['com.apple.quicktime.creationdate', 'com.apple.quicktime.model', 'com.apple.quicktime.make']) {
    const re = new RegExp('^(?:TAG:)?' + key.replace(/\./g, '\\.') + '=(.*)$', 'm');
    assert.equal(tags.match(re)?.[1], srcTags.match(re)?.[1], key);
    assert.ok(tags.match(re)?.[1]);
  }
  assert.doesNotMatch(tags, /WRONG|1999/);
  console.log(`ok ${name}: ffprobe DOVI profile 8 / compat 4, RPU side data x${nSide}/5, clean decode, tags copied`);
  return { tags, srcTags, srcMoov, encMoov, outPath };
}

const a = await pipeline('IMG_7440');
assert.match(a.tags, /creationdate=2026-06-07T12:25:04\+0900/);
const b = await pipeline('IMG_2147');
assert.match(b.tags, /creationdate=.*\+0100/);
const lens = /lens_model=(.*)/.exec(b.srcTags);
console.log('source stream/format lens tags via ffprobe:', lens ? lens[1] : '(ffprobe does not expose trak-level mdta tags; verified byte-verbatim instead)');
if (lens) assert.match(b.tags, /lens_model/);

// ---- 5b. moveUdtaMetaToMoov on a Mediabunny-like moov (udta/meta) ----
{
  const enc = a.encMoov;
  assert.ok(findBox(enc, ['moov', 'udta', 'meta']));
  const m = moveUdtaMetaToMoov(enc);
  assert.equal(findBox(m, ['moov', 'udta']), null);
  const meta = findBox(m, ['moov', 'meta']);
  assert.ok(meta);
  assert.deepEqual(childBoxes(m, meta).map((x) => x.type), ['hdlr', 'keys', 'ilst']);
  assert.equal(meta.hdr, 8); assert.equal(String.fromCharCode(...m.subarray(meta.start + 12, meta.start + 16)), 'hdlr', 'QuickTime plain meta (no version/flags)');
  assert.ok(m.length <= enc.length);
  // roundtrip through ffprobe: rebuild file from the ffmpeg encode
  const encFile = new Uint8Array(readFileSync(join(tmp, 'IMG_7440-enc.mp4')));
  const { prefixLength, moov } = await rewriteMoov(encFile, moveUdtaMetaToMoov);
  const p = join(tmp, 'moved.mp4'); writeFileSync(p, Buffer.concat([encFile.subarray(0, prefixLength), moov]));
  const t = run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'default=nw=1', p]);
  assert.match(t, /com\.apple\.quicktime\.creationdate=1999-01-01T00:00:00\+0000/);
  assert.equal(run('ffmpeg', ['-v', 'error', '-i', p, '-f', 'null', '-']).trim(), '');
  // moov before mdat must be refused
  const fs = run('ffmpeg', ['-v', 'error', '-y', '-i', join(tmp, 'IMG_7440-enc.mp4'), '-c', 'copy', '-movflags', '+faststart', join(tmp, 'fast.mp4')]);
  await assert.rejects(rewriteMoov(new Uint8Array(readFileSync(join(tmp, 'fast.mp4'))), (x) => x), /precedes mdat/);
  console.log('ok moveUdtaMetaToMoov (+ faststart refused)');
}
console.log('ALL TESTS PASSED');
