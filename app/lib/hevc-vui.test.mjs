// Run: node app/lib/hevc-vui.test.mjs   (the ffmpeg checks need /usr/bin/ffmpeg + libx265)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchHvcC, parseSps, stripParameterSets } from './hevc-vui.js';

const SAFARI_HVCC = '010220000000b0000000000078f000fcfdfafa00000f04a00001001840010c01ffff022000000300b00000030000030078170240a100010023420101022000000300b00000030000030078a00220801e072ed8817924591572e5cba2a2000100074401c0764c14c9a70001000d4e019408002fe9a03d13404280';
const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const cat = (...a) => Buffer.concat(a.map((x) => Buffer.from(x)));

// Walk an hvcC -> { header(23 bytes), arrays: {type: [nal,...]} }
function readHvcC(b) {
  const arrays = {}; let off = 23;
  for (let a = 0; a < b[22]; a++) {
    const type = b[off] & 0x3f, n = (b[off + 1] << 8) | b[off + 2]; off += 3;
    arrays[type] = [];
    for (let i = 0; i < n; i++) {
      const len = (b[off] << 8) | b[off + 1];
      arrays[type].push(b.subarray(off + 2, off + 2 + len)); off += 2 + len;
    }
  }
  assert.equal(off, b.length);
  return { header: b.subarray(0, 23), arrays };
}
function makeHvcC(header, vps, sps, pps) {
  const h = Buffer.from(header); h[22] = 3;
  const arr = (t, n) => cat([0x80 | t, 0, 1, n.length >> 8, n.length & 255], n);
  return new Uint8Array(cat(h, arr(32, vps), arr(33, sps), arr(34, pps)));
}
const annexB = (nals) => cat(...nals.map((n) => cat([0, 0, 0, 1], n)));
const splitAnnexB = (b) => {
  const out = []; let start = -1;
  for (let i = 0; i + 3 <= b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (start >= 0) out.push(b.subarray(start, b[i - 1] === 0 ? i - 1 : i));
      start = i + 3; i += 2;
    }
  }
  out.push(b.subarray(start));
  return out;
};

// Fields that must be identical before/after the patch (everything but VUI + raw rbsp).
const core = (s) => { const { rbsp, vui, vuiFields, vuiFlagPos, ...rest } = s; return rest; };

// ---- 1. Parse the real Safari hvcC ----
const hv = hex(SAFARI_HVCC);
const { arrays } = readHvcC(hv);
const sps0 = parseSps(arrays[33][0]);
assert.equal(sps0.codedWidth, 1088); assert.equal(sps0.codedHeight, 1920);
assert.ok(sps0.confWin, 'conformance window'); assert.equal(sps0.displayWidth, 1080);
assert.equal(sps0.bitDepthLuma, 10); assert.equal(sps0.bitDepthChroma, 10);
assert.equal(sps0.scalingListEnabled, 1); assert.equal(sps0.scalingListDataPresent, 0);
assert.equal(sps0.sao, 1); assert.equal(sps0.numStRps, 4); assert.equal(sps0.vui, 0);
console.log('ok 1 parse Safari hvcC', sps0.codedWidth + 'x' + sps0.codedHeight, 'vuiFlagPos=' + sps0.vuiFlagPos);

// ---- 2. Patch and re-parse ----
const patched = patchHvcC(hv);
assert.ok(patched.length > hv.length);
const p = readHvcC(patched);
assert.deepEqual(p.header.subarray(0, 22), hv.subarray(0, 22));
assert.deepEqual(p.arrays[32], arrays[32]); assert.deepEqual(p.arrays[34], arrays[34]);
const sps1 = parseSps(p.arrays[33][0]);
assert.equal(sps1.vui, 1);
assert.deepEqual(
  { ...sps1.vuiFields },
  { videoSignalTypePresent: 1, colourDescPresent: 1, videoFormat: 5, fullRange: 0, primaries: 9, transfer: 18, matrix: 9,
    colourFlagPos: sps1.vuiFields.colourFlagPos, colourPos: sps1.vuiFields.colourPos });
assert.deepEqual(core(sps1), core(sps0));
// trailing bits intact: last byte non-zero, and idempotent-ish second patch only rewrites colours in place
assert.ok(p.arrays[33][0].at(-1) !== 0);
const again = readHvcC(patchHvcC(patched, { primaries: 1, transfer: 1, matrix: 1, fullRange: true })).arrays[33][0];
assert.equal(parseSps(again).vuiFields.primaries, 1);
assert.equal(again.length, p.arrays[33][0].length);
console.log('ok 2 patch + reparse (vui=1, 9/18/9, full_range=0, other fields identical)');

// ---- 3. Independent validation with ffmpeg ----
const dir = mkdtempSync(join(tmpdir(), 'hevcvui-'));
const trace = (file) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'info', '-i', file, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], { encoding: 'utf8' });
  // no slice => ffmpeg fails on output setup ('dimensions not set'), but the headers are traced first
  assert.ok(r.stderr.includes('rbsp_stop_one_bit'), r.stderr.slice(-800));
  return r.stderr;
};
const val = (t, name) => [...t.matchAll(new RegExp(`\\b${name}\\s+[01]+ = (\\d+)`, 'g'))].map((m) => +m[1]);
const FFMPEG = existsSync('/usr/bin/ffmpeg');
if (!FFMPEG) console.log('skip 3 (no ffmpeg)');
else {
  // 3a. Safari: VPS+SPS+PPS only (no slice) -> trace_headers must parse our SPS
  const f = join(dir, 'safari.hevc');
  writeFileSync(f, annexB([p.arrays[32][0], p.arrays[33][0], p.arrays[34][0]]));
  const t = trace(f);
  assert.deepEqual(val(t, 'vui_parameters_present_flag'), [1]);
  assert.deepEqual(val(t, 'video_signal_type_present_flag'), [1]);
  assert.deepEqual(val(t, 'video_format'), [5]); assert.deepEqual(val(t, 'video_full_range_flag'), [0]);
  assert.deepEqual(val(t, 'colour_primaries'), [9]); assert.deepEqual(val(t, 'transfer_characteristics'), [18]);
  assert.deepEqual(val(t, 'matrix_coefficients'), [9]);
  assert.deepEqual(val(t, 'sps_extension_present_flag'), val(trace((writeFileSync(join(dir, 'orig.hevc'), annexB([arrays[32][0], arrays[33][0], arrays[34][0]])), join(dir, 'orig.hevc'))), 'sps_extension_present_flag'));
  assert.deepEqual(val(t, 'pic_width_in_luma_samples'), [1088]); assert.deepEqual(val(t, 'pic_height_in_luma_samples'), [1920]);
  console.log('ok 3a ffmpeg trace_headers reads patched Safari SPS (9/18/9)');

  // 3b. x265 10-bit real stream: original SPS (vui=1, no colour) and a vui-stripped variant (vui=0)
  const es = join(dir, 'x.hevc'), mp4 = join(dir, 'x.mp4');
  let r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920', '-frames:v', '2', '-c:v', 'libx265',
    '-pix_fmt', 'yuv420p10le', '-x265-params', 'info=0:log-level=error', '-f', 'hevc', es]);
  assert.equal(r.status, 0, String(r.stderr));
  r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', es, '-c', 'copy', '-tag:v', 'hvc1', mp4]);
  assert.equal(r.status, 0, String(r.stderr));
  const mp = readFileSync(mp4), i = mp.indexOf('hvcC');
  const boxLen = mp.readUInt32BE(i - 4);
  const xh = readHvcC(new Uint8Array(mp.subarray(i + 4, i - 4 + boxLen)));
  const slices = splitAnnexB(readFileSync(es)).filter((n) => ((n[0] >> 1) & 0x3f) < 32);
  const xsps = xh.arrays[33][0], xs = parseSps(xsps);
  assert.equal(xs.vui, 1); assert.equal(xs.vuiFields.colourDescPresent, 0);

  // vui-stripped copy of the x265 SPS (test-only): this x265 VUI is 15 flag/field bits long when all zero
  // except video_signal_type (format+range = 4 bits, colour flag 0): 1+1+1+3+1+1 + 7 = 15 bits after the vui flag.
  const w = [];
  const bit = (b, q) => (b[q >> 3] >> (7 - (q & 7))) & 1;
  for (let q = 0; q < xs.vuiFlagPos; q++) w.push(bit(xs.rbsp, q));
  w.push(0);
  let endBit = xs.rbsp.length * 8 - 1; while (!bit(xs.rbsp, endBit)) endBit--;
  for (let q = xs.vuiFlagPos + 1 + 15; q < endBit; q++) w.push(bit(xs.rbsp, q));
  w.push(1); while (w.length & 7) w.push(0);
  const rb = new Uint8Array(w.length >> 3); w.forEach((b, k) => { rb[k >> 3] |= b << (7 - (k & 7)); });
  const esc = []; for (let k = 0, z = 0; k < rb.length; k++) { if (z >= 2 && rb[k] <= 3) { esc.push(3); z = 0; } esc.push(rb[k]); z = rb[k] === 0 ? z + 1 : 0; }
  const stripped = Uint8Array.from([xsps[0], xsps[1], ...esc]);
  assert.equal(parseSps(stripped).vui, 0);
  assert.deepEqual(core(parseSps(stripped)), core(xs));

  for (const [name, spsIn, expectVuiBefore] of [['x265 vui=1', xsps, 1], ['x265 vui=0', stripped, 0]]) {
    const hvcc = makeHvcC(xh.header, xh.arrays[32][0], spsIn, xh.arrays[34][0]);
    const pat = patchHvcC(hvcc);
    const q = readHvcC(pat);
    assert.equal(parseSps(spsIn).vui, expectVuiBefore);
    assert.deepEqual(core(parseSps(q.arrays[33][0])), core(xs));
    const file = join(dir, name.replace(/\W/g, '_') + '.hevc');
    writeFileSync(file, annexB([q.arrays[32][0], q.arrays[33][0], q.arrays[34][0], ...slices]));
    const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_primaries,color_transfer,color_space,pix_fmt,width,height',
      '-of', 'default=nw=1', file], { encoding: 'utf8' });
    assert.equal(pr.status, 0, pr.stderr);
    for (const e of ['color_primaries=bt2020', 'color_transfer=arib-std-b67', 'color_space=bt2020nc', 'pix_fmt=yuv420p10le', 'width=1080']) assert.ok(pr.stdout.includes(e), `${name}: missing ${e}\n${pr.stdout}`);
    // slices still decode with the patched SPS
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(dec.status, 0); assert.equal(dec.stderr.trim(), '');
    console.log(`ok 3b ${name}: ffprobe bt2020 / arib-std-b67 / bt2020nc, decodes cleanly`);
  }
}

// ---- 4. stripParameterSets ----
const nal = (type, n) => { const b = new Uint8Array(4 + 2 + n); b[3] = 2 + n; b[4] = type << 1; b[5] = 1; b.fill(0xab, 6); return b; };
const mk = (...ns) => new Uint8Array(cat(...ns));
const slice = nal(19, 10), sei = nal(39, 3);
const s1 = mk(nal(32, 5), nal(33, 7), nal(34, 4), slice, sei);
assert.deepEqual(stripParameterSets(s1), mk(slice, sei));
const s2 = mk(sei, slice);
assert.equal(stripParameterSets(s2), s2);
assert.deepEqual(stripParameterSets(mk(slice, nal(34, 2)), 4), slice);
// 2-byte length prefix
const n2 = (type, n) => Uint8Array.from([0, 2 + n, type << 1, 1, ...Array(n).fill(7)]);
assert.deepEqual(stripParameterSets(mk(n2(33, 3), n2(1, 4)), 2), n2(1, 4));
console.log('ok 4 stripParameterSets');
console.log('ALL TESTS PASSED');
