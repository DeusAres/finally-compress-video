// Run: node app/lib/origin.test.mjs — originale vs versione esportata da Foto (app/lib/origin.js).
// Sorgenti: samples/IMG_2147.mov (originale fotocamera) e samples/IMG_7440.mov (copia esportata da Foto: displayname,
// AAC prima del video, niente apac). Coppia privata IMG_2813 (stesso video: originale 4K 12 MB / copia «compatibile»
// 1080p 3 MB, mai copiata nel repo): se manca → SKIP di quella parte.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateMoov } from './dovi.js';
import { inspectMovie, judgeOrigin, parseFtyp } from './origin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = '/root/.claude/uploads/41829d04-493e-5956-8e38-1bd70ab69d5c';
async function load(path) {
  const b = new Uint8Array(readFileSync(path));
  const loc = await locateMoov(async (o, l) => b.subarray(o, o + l), b.length);
  return inspectMovie(b.subarray(loc.offset, loc.offset + loc.size), b.subarray(0, 64));
}
let n = 0;

// 1) originale della fotocamera (1080p, apac, video prima traccia)
{
  const i = await load(join(ROOT, 'samples', 'IMG_2147.mov'));
  assert.equal(i.ftyp.major, 'qt  ');
  const v = i.tracks.find((t) => t.handler === 'vide');
  assert.deepEqual([v.codec, v.bitDepth, v.transfer, v.dv.profile, v.dv.compat, v.w, v.h], ['HEVC', 10, 'HLG', 8, 4, 1920, 1080]);
  assert.equal(i.tracks[0].handler, 'vide');
  assert.ok(i.tracks.some((t) => t.entry === 'apac'));
  assert.equal(i.keys['com.apple.quicktime.make'], 'Apple');
  assert.equal(judgeOrigin(i, 'IMG_2147.mov').verdict, 'originale'); n++;
}
// 2) copia esportata da Foto
{
  const i = await load(join(ROOT, 'samples', 'IMG_7440.mov'));
  const j = judgeOrigin(i, 'IMG_7440.mov');
  // Audio prima del video + displayname NON bastano (anche gli originali recenti li hanno): nessun avviso.
  assert.ok(i.tracks[0].handler === 'soun' && 'com.apple.quicktime.displayname' in i.keys);
  assert.notEqual(j.verdict, 'esportato');
  assert.equal(j.reasons.length, 0);
  assert.equal(i.keys['com.apple.quicktime.displayname'], 'IMG_7440');
  assert.ok(i.tracks.find((t) => t.entry === 'mebx' && t.keys.includes('video-orientation'))); n++;
}
// 2b) prove forti sintetiche: H.264 senza mebx in IMG_xxxx → esportato; HEVC 8 bit senza mebx → esportato; con nome non IMG_ no
{
  const base = await load(join(ROOT, 'samples', 'IMG_2147.mov'));
  const mk = (codec, bitDepth, mebx) => ({ ...base, tracks: base.tracks.filter((t) => mebx || t.entry !== 'mebx').map((t) => t.handler === 'vide' ? { ...t, codec, bitDepth } : t) });
  assert.equal(judgeOrigin(mk('H.264', 8, false), 'IMG_0001.MOV').verdict, 'esportato');
  assert.equal(judgeOrigin(mk('HEVC', 8, false), 'IMG_0001.MOV').verdict, 'esportato');
  assert.notEqual(judgeOrigin(mk('H.264', 8, false), 'clip.mov').verdict, 'esportato');
  assert.equal(judgeOrigin(mk('HEVC', 10, true), 'IMG_0001.MOV').verdict, 'originale'); n++;
}
// 3) non iPhone → sconosciuto; ftyp
{
  const i = await load(join(ROOT, 'samples', 'IMG_2147.mov'));
  delete i.keys['com.apple.quicktime.make'];
  assert.equal(judgeOrigin(i, 'clip.mov').verdict, 'sconosciuto');
  assert.equal(parseFtyp(new Uint8Array(8)), null); n++;
}
// 4) coppia privata: stesso video, originale 4K vs copia «compatibile» 1080p senza apac
const orig = join(UP, '7182b98d-IMG_2813.mov'), comp = join(UP, '0e19b6a1-IMG_2813.mov');
if (existsSync(orig) && existsSync(comp)) {
  const a = await load(orig), b = await load(comp);
  assert.equal(judgeOrigin(a, 'IMG_2813.MOV').verdict, 'originale');
  assert.notEqual(judgeOrigin(a, 'IMG_2813.MOV').verdict, 'esportato'); assert.notEqual(judgeOrigin(b, 'IMG_2813.MOV').verdict, 'esportato'); // copia 10 bit non rilevabile con prove forti
  const va = a.tracks.find((t) => t.handler === 'vide'), vb = b.tracks.find((t) => t.handler === 'vide');
  assert.deepEqual([va.w, vb.w, vb.bitDepth, !!vb.dv], [3840, 1920, 10, true]);
  assert.ok(a.tracks.some((t) => t.entry === 'apac') && !b.tracks.some((t) => t.entry === 'apac')); n++;
} else console.log('SKIP coppia privata IMG_2813');
console.log(`origin: ${n} casi OK`);
