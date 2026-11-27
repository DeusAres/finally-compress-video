// Miniature della coda SENZA <video> (v0.38.7): Mediabunny Input → keyframe vicino al 10 % → VideoDecoder (un solo pacchetto + flush)
// → VideoFrame → canvas ridotto (con la rotazione della traccia) → JPEG. Frame HLG slavati: per una miniatura va bene.
import * as MB from '../../vendor/mediabunny-1.65.1.min.mjs';

/** Istante (s) del keyframe da cercare: 10 % della durata, mai oltre la fine; durata ignota → 0 (primo pacchetto). */
export function thumbTime(durationS, frac = 0.1) { return Number.isFinite(durationS) && durationS > 0 ? Math.min(durationS * frac, Math.max(0, durationS - 0.05)) : 0; }

/** Dimensioni del canvas (lato lungo ≤ maxSide, mai ingrandito) per frame w×h e rotazione 0/90/180/270; quarter = quarti di giro orari. */
export function thumbDims(w, h, rotation = 0, maxSide = 96) {
  const rot = ((Math.round((rotation || 0) / 90) % 4) + 4) % 4, sw = rot % 2 ? h : w, sh = rot % 2 ? w : h, k = Math.min(1, maxSide / Math.max(sw, sh, 1));
  return { cw: Math.max(1, Math.round(sw * k)), ch: Math.max(1, Math.round(sh * k)), quarter: rot, k };
}

/** Disegna `src` (w×h) su `ctx` di cw×ch ruotando di `quarter` quarti di giro orari. */
export function drawRotated(ctx, src, w, h, { cw, ch, quarter, k }) {
  ctx.save(); ctx.translate(cw / 2, ch / 2); ctx.rotate(quarter * Math.PI / 2); ctx.drawImage(src, -w * k / 2, -h * k / 2, w * k, h * k); ctx.restore();
}

/** File → dataURL JPEG (o null: nessun decoder / codec non supportato / errore). Mai <video>. */
export async function makeThumb(file, { maxSide = 96, timeoutMs = 8000 } = {}) {
  if (typeof VideoDecoder === 'undefined' || typeof document === 'undefined') return null;
  let input = null, dec = null, frame = null, t;
  try {
    input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack(); if (!track) return null;
    const config = await track.getDecoderConfig(); if (!config) return null;
    if (!(await VideoDecoder.isConfigSupported(config))?.supported) return null;
    const sink = new MB.EncodedPacketSink(track);
    let dur = NaN; try { dur = await track.computeDuration(); } catch {}
    const at = thumbTime(dur);
    const key = (at > 0 && await sink.getKeyPacket(at)) || await sink.getFirstPacket(); if (!key) return null;
    const rotation = track.rotation || 0;
    const work = new Promise((res, rej) => {
      dec = new VideoDecoder({ output: (f) => { if (frame) f.close(); else { frame = f; res(); } }, error: rej });
      dec.configure(config); dec.decode(key.toEncodedVideoChunk());
      dec.flush().then(() => { if (!frame) rej(new Error('nessun frame')); }, rej);
    });
    await Promise.race([work, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), timeoutMs); })]);
    const w = frame.displayWidth || frame.codedWidth, h = frame.displayHeight || frame.codedHeight, d = thumbDims(w, h, rotation, maxSide);
    const c = document.createElement('canvas'); c.width = d.cw; c.height = d.ch;
    drawRotated(c.getContext('2d'), frame, w, h, d);
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
  finally { clearTimeout(t); try { frame?.close(); } catch {} try { if (dec && dec.state !== 'closed') dec.close(); } catch {} try { input?.dispose?.(); } catch {} }
}
