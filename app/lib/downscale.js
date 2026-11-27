// «Riduci a 1080p» (v0.31, default OFF): logica PURA (Node: app/lib/downscale.test.mjs). Nessun ripiego: se l'encoder non scala
// mantenendo i 10 bit il job si ferma (DownscaleError). Il passaggio via canvas/WebGPU darebbe 8 bit = niente HDR: vietato (research/02 §10 run 4).
import { parseSps } from './hevc-vui.js?v=0.37.3';

export const DS_SHORT = 1080;
export const DS_MESSAGE = 'Safari non riesce a ridurre la risoluzione mantenendo l\'HDR a 10 bit: riprova senza «Riduci a 1080p».';
export const dsError = (detail) => Object.assign(new Error(DS_MESSAGE), { name: 'DownscaleError', detail });

/** L'opzione ha senso solo se il lato corto della sorgente supera 1080. */
export const canDownscale = (W, H) => Math.min(W || 0, H || 0) > DS_SHORT;

/** Dimensioni di uscita: lato corto 1080, lato lungo in proporzione (pari), stesso orientamento di W×H. null se non serve. */
export function downscaleDims(W, H, short = DS_SHORT) {
  if (!(Math.min(W, H) > short)) return null;
  const portrait = H >= W, s = Math.min(W, H), l = Math.max(W, H);
  const lo = Math.round(l * short / s / 2) * 2, exact = Number.isInteger(l * short / s) && (l * short / s) % 2 === 0;
  return { width: portrait ? short : lo, height: portrait ? lo : short, exact };
}

/** Frame rate medio (frame / durata, 2 decimali) per la configurazione dell'encoder; per VFR è la media. Default 60 se ignoto. */
export const avgFramerate = (nFrames, durS) => (nFrames > 0 && durS > 0 ? Math.round(nFrames / durS * 100) / 100 : 60);

/** SPS (NAL con header) dentro un hvcC (ISO 14496-15). null se assente. */
export function spsFromHvcC(hvcC) {
  const b = hvcC instanceof Uint8Array ? hvcC : new Uint8Array(hvcC.buffer ? hvcC.buffer.slice(hvcC.byteOffset, hvcC.byteOffset + hvcC.byteLength) : hvcC);
  if (b.length < 23) return null;
  let off = 23;
  for (let a = 0; a < b[22]; a++) {
    if (off + 3 > b.length) return null;
    const type = b[off] & 0x3f, n = (b[off + 1] << 8) | b[off + 2]; off += 3;
    for (let i = 0; i < n; i++) {
      const len = (b[off] << 8) | b[off + 1]; off += 2;
      if (off + len > b.length) return null;
      if (type === 33) return b.subarray(off, off + len);
      off += len;
    }
  }
  return null;
}

/**
 * Verifica l'uscita dell'encoder rispetto a quanto chiesto. desc = decoderConfig.description (hvcC), want = {width, height}.
 * Dimensioni: area VISIBILE (coded − conformance window; l'SPS di VT è 1088 con crop a 1080) e, se il crop manca, il coded.
 * Bit depth: SPS luma+chroma e campo dell'hvcC; richiesti 10.
 * Ritorna {ok, why, w, h, codedW, codedH, bitDepth, profile}.
 */
export function verifyDownscale(desc, want) {
  const sps = spsFromHvcC(desc);
  if (!sps) return { ok: false, why: 'SPS assente nell\'hvcC' };
  let s; try { s = parseSps(sps); } catch (e) { return { ok: false, why: 'SPS non leggibile: ' + (e?.message || e) }; }
  const b = desc instanceof Uint8Array ? desc : new Uint8Array(desc.buffer ? desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength) : desc);
  const hvccDepth = (b[17] & 7) + 8;
  const r = { w: s.displayWidth, h: s.displayHeight, codedW: s.codedWidth, codedH: s.codedHeight, bitDepth: s.bitDepthLuma, bitDepthChroma: s.bitDepthChroma, hvccDepth, profile: b[1] & 31 };
  const why = [];
  if (r.w !== want.width || r.h !== want.height) why.push(`dimensioni ${r.w}×${r.h} (coded ${r.codedW}×${r.codedH}) invece di ${want.width}×${want.height}`);
  if (r.bitDepth < 10 || r.bitDepthChroma < 10 || hvccDepth < 10) why.push(`bit depth ${r.bitDepth}/${r.bitDepthChroma} (hvcC ${hvccDepth}) invece di 10`);
  return { ok: !why.length, why: why.join('; '), ...r };
}
