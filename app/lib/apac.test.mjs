// Run: node app/lib/apac.test.mjs   (needs ffmpeg/ffprobe with libx265). Sources: samples/IMG_2147.mov (repo) and a private 4K
// iPhone file (APAC_PRIVATE or the default upload path, never copied into the repo). Missing files -> SKIP.
//
// Emulates the app: "Mediabunny-like" output = video re-encoded x265 + AAC copied, moov at the end (no faststart);
// then rewriteMoov (copySourceMetadata) -> truncate at prefixLength -> second mdat with the apac chunks streamed from the
// source -> moov + apac trak. Checks with ffprobe: apac listed (tag apac, 4 ch, 48 kHz), same packet count and same
// per-packet SHA-256 as the source, tkhd flags/alternate_group as in the source (apac and AAC), decodable, durations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, openSync, readSync, writeSync, fstatSync, ftruncateSync, closeSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateMoov } from './dovi.js';
import { copySourceMetadata, rewriteMoov } from './mp4-post.js';
import { readApacTrack, planApacMdat, copyApacData, addApacTrack, listTracks, shiftEdits } from './apac.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRIVATE = process.env.APAC_PRIVATE || '/root/.claude/uploads/41829d04-493e-5956-8e38-1bd70ab69d5c/5a829807-IMG_2790.mov';
const SOURCES = [join(ROOT, 'samples', 'IMG_2147.mov'), PRIVATE];
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }); assert.equal(r.status, 0, cmd + ' ' + args.join(' ') + '\n' + r.stderr); return r.stdout; };
const probe = (f, args) => JSON.parse(run('ffprobe', ['-v', 'error', '-of', 'json', ...args, f]));
function fileReader(path) {
  const fd = openSync(path, 'r'); const size = fstatSync(fd).size;
  return { fd, size, read: async (o, l) => { const b = Buffer.alloc(Math.max(0, Math.min(l, size - o))); readSync(fd, b, 0, b.length, o); return new Uint8Array(b.buffer, b.byteOffset, b.length); } };
}
const pktHashes = (f, streamSel) => run('ffprobe', ['-v', 'error', '-select_streams', streamSel, '-show_data_hash', 'sha256', '-show_entries', 'packet=size,data_hash', '-of', 'csv=p=0', f]).trim().split('\n');

// --- unit: edit list shift (no samples cut: media_time moves forward, duration shrinks; rescaled to the output timescale)
{
  const e = [{ segmentDuration: 2117, mediaTime: 1168, rate: 1 }];
  assert.deepEqual(shiftEdits(e, { srcMovieTs: 600, outMovieTs: 1000, mediaTs: 48000, shiftS: 0 }), [{ segmentDuration: 3528, mediaTime: 1168, rate: 1 }]);
  assert.deepEqual(shiftEdits(e, { srcMovieTs: 600, outMovieTs: 600, mediaTs: 48000, shiftS: 0.1 }), [{ segmentDuration: 2057, mediaTime: 1168 + 4800, rate: 1 }]);
  assert.deepEqual(shiftEdits([{ segmentDuration: 60, mediaTime: -1, rate: 1 }, ...e], { srcMovieTs: 600, outMovieTs: 600, mediaTs: 48000, shiftS: 0.05 }), [{ segmentDuration: 30, mediaTime: -1, rate: 1 }, ...e]);
  assert.equal(shiftEdits(null, { srcMovieTs: 600, outMovieTs: 600, mediaTs: 48000, shiftS: 0.1 }), null);
  console.log('ok shiftEdits');
}

async function transplant(src, outPath, { co64 = null, shiftS = 0 } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'apac-'));
  const s = fileReader(src);
  const loc = await locateMoov(s.read, s.size); const srcMoov = (await s.read(loc.offset, loc.size)).slice();
  const track = readApacTrack(srcMoov); assert.ok(track, 'apac atteso in ' + src);
  // "Mediabunny-like" output: x265 + AAC copy, moov at the end
  const streams = probe(src, ['-show_entries', 'stream=index,codec_name,codec_tag_string']).streams;
  const aacIdx = streams.find((x) => x.codec_name === 'aac').index;
  const base = join(tmp, 'mb.mp4');
  run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', `0:${aacIdx}`, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-vf', 'scale=-2:360', '-tag:v', 'hvc1', '-c:a', 'copy', base]);
  copyFileSync(base, outPath);
  const o = fileReader(outPath);
  const { prefixLength, moov } = await rewriteMoov({ size: o.size, read: o.read }, (m) => copySourceMetadata(srcMoov, m));
  closeSync(o.fd);
  const fd = openSync(outPath, 'r+');
  ftruncateSync(fd, prefixLength);
  const plan = planApacMdat(track, prefixLength);
  writeSync(fd, plan.header, 0, plan.header.length, prefixLength);
  let writes = 0;
  const n = await copyApacData(track, { read: s.read, write: async (p, u8) => { writes++; writeSync(fd, u8, 0, u8.length, p); }, pos: plan.dataStart, blockSize: 64 * 1024 });
  assert.equal(n, track.totalBytes);
  const r = addApacTrack(moov, track, { chunkOffsets: plan.chunkOffsets, shiftS, co64 });
  writeSync(fd, r.moov, 0, r.moov.length, prefixLength + plan.size);
  closeSync(fd); closeSync(s.fd); rmSync(tmp, { recursive: true, force: true });
  return { srcMoov, track, r, plan, writes, outMoov: r.moov };
}

let ran = 0;
for (const src of SOURCES) {
  if (!existsSync(src)) { console.log('SKIP (file mancante): ' + src); continue; }
  for (const variant of [{}, { co64: true }]) {
    const out = join(mkdtempSync(join(tmpdir(), 'apac-out-')), 'out.mp4');
    const { srcMoov, track, r, plan, writes, outMoov } = await transplant(src, out, variant);
    const name = src.split('/').pop() + (variant.co64 ? ' [co64]' : '');
    // 1. ffprobe sees the apac track: tag, channels, rate, packet count
    const st = probe(out, ['-show_entries', 'stream=index,codec_type,codec_tag_string,channels,sample_rate,nb_frames,duration']).streams;
    const sst = probe(src, ['-show_entries', 'stream=index,codec_type,codec_tag_string,channels,sample_rate,nb_frames,duration']).streams;
    const a = st.find((x) => x.codec_tag_string === 'apac'), sa = sst.find((x) => x.codec_tag_string === 'apac');
    assert.ok(a, name + ': traccia apac assente'); assert.equal(a.channels, 4); assert.equal(+a.sample_rate, 48000);
    assert.equal(+a.nb_frames, +sa.nb_frames, name + ': numero di pacchetti apac');
    assert.equal(+a.nb_frames, track.sampleCount);
    assert.ok(Math.abs(+a.duration - +sa.duration) < 0.002, `${name}: durata apac ${a.duration} vs ${sa.duration}`);
    // 2. identical packet bytes (per-packet sha256)
    const audioIdx = (list, idx) => list.filter((x) => x.codec_type === 'audio').findIndex((x) => x.index === idx);
    const hOut = pktHashes(out, 'a:' + audioIdx(st, a.index)), hSrc = pktHashes(src, 'a:' + audioIdx(sst, sa.index));
    assert.equal(hOut.length, hSrc.length); assert.deepEqual(hOut, hSrc, name + ': byte dei pacchetti apac diversi');
    // 3. tkhd flags / alternate_group as in the source (apac and AAC), tref fall, next_track_ID
    const sT = listTracks(srcMoov), oT = listTracks(outMoov);
    const sApac = sT.find((t) => t.entry === 'apac'), sAac = sT.find((t) => t.entry === 'mp4a');
    const oApac = oT.find((t) => t.entry === 'apac'), oAac = oT.find((t) => t.entry === 'mp4a');
    assert.equal(oApac.flags, sApac.flags, name + ': flags apac'); assert.equal(oApac.alternateGroup, sApac.alternateGroup);
    assert.equal(oAac.flags, sAac.flags, name + ': flags AAC'); assert.equal(oAac.alternateGroup, sAac.alternateGroup);
    assert.equal(oApac.trackId, r.trackId); assert.equal(new Set(oT.map((t) => t.trackId)).size, oT.length, 'track_ID univoci');
    assert.equal(oApac.edits.length, sApac.edits.length); assert.equal(oApac.edits[0].mediaTime, sApac.edits[0].mediaTime, 'elst media_time invariato (shift 0)');
    if (track.fallbackTrackId) assert.ok(Buffer.from(outMoov).includes(Buffer.concat([Buffer.from('fall'), Buffer.from([0, 0, 0, r.aacTrackId])])), 'tref fall -> AAC');
    // 4. still decodable (video + first audio = AAC) and coherent duration
    run('ffmpeg', ['-v', 'error', '-i', out, '-map', '0:v', '-map', '0:a:0', '-f', 'null', '-']);
    const dOut = +probe(out, ['-show_entries', 'format=duration']).format.duration, dSrc = +probe(src, ['-show_entries', 'format=duration']).format.duration;
    assert.ok(Math.abs(dOut - dSrc) < 0.1, `${name}: durata ${dOut} vs ${dSrc}`);
    // 5. the file is still a valid "moov last" MP4 (a second rewrite would work)
    const fo = fileReader(out); await rewriteMoov({ size: fo.size, read: fo.read }, (m) => m); closeSync(fo.fd);
    if (variant.co64) assert.ok(Buffer.from(outMoov).includes(Buffer.from('co64')));
    console.log(`ok ${name}: apac ${track.sampleCount} campioni, ${(track.totalBytes / 1048576).toFixed(2)} MB in ${track.chunks.length} chunk (${writes} scritture), traccia ${r.trackId}, gruppo ${r.alternateGroup}, flags apac 0x${oApac.flags.toString(16)} AAC 0x${oAac.flags.toString(16)}, mdat apac a ${plan.dataStart - plan.header.length}, durata ${dOut.toFixed(3)} s`);
    rmSync(dirname(out), { recursive: true, force: true });
    ran++;
  }
}
// readApacTrack on a file without apac -> null
{ const f = join(ROOT, 'samples', 'IMG_7440_hdr.mp4');
  if (existsSync(f)) { const s = fileReader(f); const loc = await locateMoov(s.read, s.size); assert.equal(readApacTrack(await s.read(loc.offset, loc.size)), null); closeSync(s.fd); console.log('ok nessuna apac -> null'); } }
console.log(ran ? `apac: ${ran} trapianti OK` : 'SKIP: nessun file sorgente con apac');
