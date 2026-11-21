// Run: node app/lib/downscale.test.mjs   (le verifiche su hvcC reali usano ffmpeg + libx265; senza ffmpeg salta quelle)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downscaleDims, canDownscale, avgFramerate, spsFromHvcC, verifyDownscale, dsError, DS_MESSAGE } from './downscale.js';

// ---- dimensioni / frame rate ----
assert.deepEqual(downscaleDims(2160, 3840), { width: 1080, height: 1920, exact: true });
assert.deepEqual(downscaleDims(3840, 2160), { width: 1920, height: 1080, exact: true });
assert.deepEqual(downscaleDims(2160, 2880), { width: 1080, height: 1440, exact: true });
assert.equal(downscaleDims(1080, 1920), null); assert.equal(downscaleDims(1920, 1080), null);
const odd = downscaleDims(1500, 2001); assert.equal(odd.width, 1080); assert.equal(odd.height % 2, 0); assert.equal(odd.exact, false);
assert.ok(canDownscale(2160, 3840) && !canDownscale(1080, 1920) && !canDownscale(0, 0) && !canDownscale(undefined, 3840));
assert.equal(avgFramerate(211, 3.5166), 60); assert.equal(avgFramerate(300, 10.01), 29.97); assert.equal(avgFramerate(0, 1), 60);
const e = dsError('x'); assert.equal(e.name, 'DownscaleError'); assert.equal(e.message, DS_MESSAGE); assert.match(e.message, /senza «Riduci a 1080p»/);
console.log('ok 1 dimensioni, frame rate, errore');

// ---- hvcC reale di Safari (iPhone 17 Pro Max, v0.x): SPS 1088×1920 con crop a 1080, 10 bit ----
const SAFARI_HVCC = '010220000000b0000000000078f000fcfdfafa00000f04a00001001840010c01ffff022000000300b00000030000030078170240a100010023420101022000000300b00000030000030078a00220801e072ed8817924591572e5cba2a2000100074401c0764c14c9a70001000d4e019408002fe9a03d13404280';
const sf = Uint8Array.from(Buffer.from(SAFARI_HVCC, 'hex'));
assert.ok(spsFromHvcC(sf));
let v = verifyDownscale(sf, { width: 1080, height: 1920 });
assert.ok(v.ok, v.why); assert.equal(v.w, 1080); assert.equal(v.codedW, 1088); assert.equal(v.bitDepth, 10); assert.equal(v.profile, 2);
v = verifyDownscale(sf, { width: 2160, height: 3840 }); assert.ok(!v.ok); assert.match(v.why, /dimensioni 1080×1920 \(coded 1088×1920\) invece di 2160×3840/);
v = verifyDownscale(sf, { width: 1920, height: 1080 }); assert.ok(!v.ok, 'orientamento scambiato = non conforme');
// hvcC troncato / senza SPS
assert.equal(verifyDownscale(sf.subarray(0, 23), { width: 1080, height: 1920 }).ok, false);
assert.equal(verifyDownscale(new Uint8Array(5), { width: 1080, height: 1920 }).ok, false);
// ArrayBuffer (come decoderConfig.description)
assert.ok(verifyDownscale(sf.buffer.slice(sf.byteOffset, sf.byteOffset + sf.byteLength), { width: 1080, height: 1920 }).ok);
// 8 bit: stesso hvcC con bit_depth del campo hvcC alterato -> rifiutato
const sf8 = Uint8Array.from(sf); sf8[17] = (sf8[17] & ~7) | 0; v = verifyDownscale(sf8, { width: 1080, height: 1920 });
assert.ok(!v.ok); assert.match(v.why, /bit depth/);
console.log('ok 2 hvcC Safari: 1088→1080 accettato, dimensioni/orientamento/bit depth errati rifiutati');

// ---- hvcC da x265 reali: 1080×1920 10 bit, 8 bit, 4K 10 bit ----
if (spawnSync('ffmpeg', ['-version']).status !== 0) console.log('SKIP ffmpeg assente: test x265 saltati');
else {
  const dir = mkdtempSync(join(tmpdir(), 'ds-'));
  const hvcc = (w, h, pix) => {
    const f = join(dir, `${w}x${h}-${pix}.mp4`);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}`, '-frames:v', '2', '-c:v', 'libx265', '-pix_fmt', pix, '-x265-params', 'info=0:log-level=error', '-tag:v', 'hvc1', f]);
    assert.equal(r.status, 0, String(r.stderr));
    const m = readFileSync(f), i = m.indexOf('hvcC'), len = m.readUInt32BE(i - 4);
    return new Uint8Array(m.subarray(i + 4, i - 4 + len));
  };
  const want = { width: 1080, height: 1920 };
  v = verifyDownscale(hvcc(1080, 1920, 'yuv420p10le'), want); assert.ok(v.ok, v.why); assert.equal(v.bitDepth, 10); assert.equal(v.h, 1920);
  v = verifyDownscale(hvcc(1080, 1920, 'yuv420p'), want); assert.ok(!v.ok); assert.equal(v.bitDepth, 8); assert.match(v.why, /bit depth 8\/8 \(hvcC 8\) invece di 10/);
  v = verifyDownscale(hvcc(2160, 3840, 'yuv420p10le'), want); assert.ok(!v.ok); assert.equal(v.w, 2160); assert.match(v.why, /2160×3840/);
  v = verifyDownscale(hvcc(1920, 1080, 'yuv420p10le'), { width: 1920, height: 1080 }); assert.ok(v.ok, v.why);
  v = verifyDownscale(hvcc(1080, 1920, 'yuv420p10le'), { width: 1920, height: 1080 }); assert.ok(!v.ok);
  console.log('ok 3 hvcC x265: 1080p 10 bit ok; 8 bit e 4K rifiutati; orientamento verificato');
}
console.log('ALL TESTS PASSED');
