// «Qualità garantita per scena» (v0.28, sperimentale, default OFF): ricerca a circuito chiuso del bitrate
// per ogni segmento dell'export (research/12 §7), allineata ai segmenti di jobstore.planSegments così la
// ripresa resta valida (stesso segStarts, risultati salvati nel manifest per segmento).
//
// Per segmento k:
//   finestra di prova ~1 s CENTRATA nel segmento (research/12 §4: trialPick 'center')
//   encodeTrial: gli stessi frame nativi (seek + rVFC, 1 o 2 player come l'encode finale) alimentano 1–2
//                VideoEncoder SEPARATI (uno per bitrate, keyframe sul primo frame); in parallelo la luma della
//                sorgente viene presa dal frame nativo con canvas 2D a ½ risoluzione (frame sì, frame no)
//   measure:     VideoDecoder sui chunk di prova → stessa funzione canvas → SSIM (quality.frameScore) → ssimDb
//   ratecontrol.searchBitrate: ssimDb → VMAF stimato (taratura research/12 §3) → interpolazione log-rate →
//                bitrate minimo con VMAF stimato ≥ 88 (+1 s.d.) e p5 ≥ 72 (+1 s.d.); 2° giro se estrapolato.
// Il bitrate di ogni punto è quello REALE prodotto dalla prova (byte × 8 / durata), non quello configurato:
// il rate control VT segue il tempo reale (brctl.js) e l'encode finale è corretto a circuito chiuso verso il
// bitrate REALE del segmento, quindi prove e finale parlano della stessa grandezza.
//
// Bitrate scelto dall'utente = LIMITE SUPERIORE (ceiling) della ricerca: il file non supera mai la stima a
// bitrate fisso (controllo spazio OPFS e stima peso restano un limite valido); per i tratti difficili che
// richiederebbero di più il log segnala «limite raggiunto». Punto di partenza: prior 0.4 × bitrate sorgente
// della finestra (research/12 §4), mai oltre il limite; senza dimensioni dei pacchetti, il limite stesso.
//
// Luma via canvas su ENTRAMBI i lati (sorgente nativa e prova decodificata): quality.js richiede che i due lati
// passino dalla stessa funzione (il browser applica la propria YCbCr→RGB ed eventualmente il tone mapping HLG).
// Memoria: la cache della luma sorgente è Uint8 a ½ risoluzione e solo frame pari (1080×1920 → 0.5 MB × 30 =
// 15 MB per finestra), liberata a fine segmento; chunk di prova ≈ 1–3 MB; encoder/decoder di prova sempre chiusi
// (finally) PRIMA dell'encode finale, che non coesiste mai con loro (research/12 §7.9, research/03).
import { searchBitrate, predictBitrate, DEFAULTS as RC } from './ratecontrol.js?v=0.29';
import { frameScore, decodeChunks, pool, estimateVmaf } from './quality.js?v=0.29';

export const SCENE = Object.freeze({
  targetVmaf: RC.targetVmaf,   // 88 (BIBBIA §12)
  trialSec: 1.0,               // finestra di prova (research/12 §2/§5)
  stride: 2,                   // metrica su un frame ogni 2 (PLCC 0.958 → 0.956, research/12 §2)
  factor: 2,                   // luma a ½ risoluzione (540×960 per 1080×1920)
  floor: 2e6,                  // bitrate minimo (ratecontrol DEFAULTS.minBitrate)
  timeFactor: 1.7,             // tempo totale ≈ 1.7× (research/12 §6): usato dalla stima in UI
  maxFails: 2,                 // dopo N segmenti consecutivi falliti le prove si spengono per il resto del job
});

// ---------------------------------------------------------------------------------------------
// Parte pura (Node: app/lib/scenesearch.test.mjs)
// ---------------------------------------------------------------------------------------------

/** Finestra contigua di ~trialSec centrata nel segmento [startIdx, endIdx). frames: [{dur (s), size?}]. */
export function centerWindow(frames, startIdx, endIdx, trialSec = SCENE.trialSec) {
  let segDur = 0; for (let i = startIdx; i < endIdx; i++) segDur += frames[i].dur;
  if (segDur <= trialSec + 1e-6) return win(frames, startIdx, endIdx);
  // primo frame il cui inizio è ≥ centro − trialSec/2
  let t = 0, s = startIdx; const t0 = (segDur - trialSec) / 2;
  while (s < endIdx && t + frames[s].dur / 2 < t0) { t += frames[s].dur; s++; }
  let d = 0, e = s; while (e < endIdx && d < trialSec - 1e-6) { d += frames[e].dur; e++; }
  return win(frames, s, e);
}
function win(frames, s, e) {
  let d = 0, b = 0; for (let i = s; i < e; i++) { d += frames[i].dur; b += frames[i].size || 0; }
  return { startIdx: s, endIdx: e, duration: d, srcBitrate: d > 0 ? b * 8 / d : 0 };
}

/**
 * Piano della ricerca sui segmenti dell'export. frames: [{dur, size?}] (presentazione, come index.html);
 * segStarts: jobstore.planSegments; ceiling: bitrate scelto dall'utente (bit/s) = limite superiore.
 */
export function planSceneSegments(frames, segStarts, ceiling, o = {}) {
  const N = frames.length, floor = Math.min(o.floor ?? SCENE.floor, ceiling), trialSec = o.trialSec ?? SCENE.trialSec;
  const hasSizes = frames.some((f) => f.size > 0);
  return segStarts.map((startIdx, k) => {
    const endIdx = k + 1 < segStarts.length ? segStarts[k + 1] : N;
    const all = win(frames, startIdx, endIdx), trialWindow = centerWindow(frames, startIdx, endIdx, trialSec);
    const prior = hasSizes && trialWindow.srcBitrate > 0 ? predictBitrate(trialWindow.srcBitrate, { ...RC, minBitrate: floor, maxBitrate: ceiling }) : ceiling;
    return { k, startIdx, endIdx, duration: all.duration, srcBitrate: all.srcBitrate, trialWindow, prior };
  });
}

const r2 = (x) => Math.round(x * 100) / 100;
const v100 = (q) => r2(Math.min(100, q)); // la taratura è lineare: oltre 100 (contenuti statici/facili) il valore non ha senso, si mostra 100
/** Record compatto salvato nel manifest della ripresa per il segmento (bitrate in bit/s, VMAF stimati). */
export function toRecord(res, ms) {
  return { b: res.bitrate, why: res.reason, prior: Math.round(res.prior),
    pts: res.points.map((p) => ({ b: Math.round(p.bitrate), req: Math.round(p.requested ?? p.bitrate), q: v100(p.q), ql: v100(p.qLow), db: r2(p.pooled.mean) })),
    est: estAtChoice(res), ms: Math.round(ms) };
}
// VMAF stimato al bitrate scelto. ratecontrol interpola/estrapola fra i punti; due casi limite si trattano qui in modo conservativo:
// scelto ≥ tutti i punti (qualità monotona ⇒ almeno quella del punto più alto) e punti quasi coincidenti in bitrate reale
// (contenuto statico: l'encoder non spende i bit richiesti) → pendenza standard dal punto più basso invece di una pendenza esplosa.
function estAtChoice(res) {
  const p = [...res.points].sort((a, c) => a.bitrate - c.bitrate), lo = p[0], hi = p[p.length - 1], b = res.bitrate;
  if (!p.length) return null;
  if (b >= hi.bitrate) return { q: v100(hi.q), ql: v100(hi.qLow) };
  if (b <= lo.bitrate && Math.log2(hi.bitrate / lo.bitrate) < 0.07) { const d = RC.slopePerDoubling * Math.log2(b / lo.bitrate); return { q: v100(lo.q + d), ql: v100(lo.qLow + d) }; }
  return { q: v100(res.est.mean), ql: v100(res.est.low) };
}
export const fallbackRecord = (ceiling, err, ms) => ({ b: ceiling, why: 'fallback', err: String(err?.message || err).slice(0, 160), pts: [], est: null, ms: Math.round(ms || 0) });

const mb = (b) => (b / 1e6).toFixed(1);
const WHY = { 'clamped-max': ' (limite = bitrate scelto: la soglia richiederebbe di più)', 'clamped-min': ' (minimo)', searched: '', fallback: ' (prove fallite: bitrate dell\'utente)', off: ' (prove disattivate: bitrate dell\'utente)' };
/** Riga di log: «scena n: prove a x/y Mbps → VMAF stimato a/b → scelto z Mbps (reale w Mbps)». */
export function sceneLine(k, rec, real) {
  const tail = real > 0 ? ` (reale ${mb(real)} Mbps)` : '';
  if (!rec.pts?.length) return `scena ${k + 1}: nessuna prova${rec.err ? ` [${rec.err}]` : ''} → ${mb(rec.b)} Mbps${WHY[rec.why] ?? ''}${tail}`;
  const pts = [...rec.pts].sort((a, b) => a.b - b.b);
  return `scena ${k + 1}: prove a ${pts.map((p) => mb(p.b)).join('/')} Mbps → VMAF stimato ${pts.map((p) => p.q.toFixed(1)).join('/')} → scelto ${mb(rec.b)} Mbps${WHY[rec.why] ?? ''}${tail}`;
}

/**
 * Riepilogo: distribuzione (istogramma a passi di 1 Mbps), bitrate min/max/medio (pesato sulla durata), medio reale,
 * VMAF stimato min/medio al bitrate scelto (solo segmenti provati), tempo delle prove.
 * segs: [{duration}], recs: record per segmento (anche null), reals: bit/s reali per segmento (facoltativo).
 */
export function sceneSummary(segs, recs, reals = []) {
  let bd = 0, d = 0, rd = 0, rdd = 0, min = Infinity, max = 0, ms = 0, nFb = 0, nCap = 0; const q = [], hist = new Map();
  segs.forEach((s, k) => {
    const r = recs[k]; if (!r) return;
    bd += r.b * s.duration; d += s.duration; min = Math.min(min, r.b); max = Math.max(max, r.b); ms += r.ms || 0;
    if (r.why === 'fallback' || r.why === 'off') nFb++; if (r.why === 'clamped-max') nCap++;
    if (r.est) q.push(r.est.q);
    if (reals[k] > 0) { rd += reals[k] * s.duration; rdd += s.duration; }
    const h = Math.floor(r.b / 1e6); hist.set(h, (hist.get(h) || 0) + 1);
  });
  if (!d) return null;
  const dist = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([h, n]) => `${h}–${h + 1} Mbps ×${n}`).join(' · ');
  return { n: recs.filter(Boolean).length, min, max, mean: bd / d, realMean: rdd ? rd / rdd : 0, dist,
    vmafMin: q.length ? Math.min(...q) : NaN, vmafMean: q.length ? q.reduce((a, b) => a + b, 0) / q.length : NaN, trialS: ms / 1000, fallbacks: nFb, capped: nCap };
}

/** Luma 8-bit (range limitato 16..235, come un piano Y di decoder) da pixel RGBA di canvas, senza copia Float32. */
export function lumaU8FromRGBA(px, width, height, [kr, kg, kb] = [0.2126, 0.7152, 0.0722]) {
  const y = new Uint8ClampedArray(width * height), k = 219 / 255;
  for (let i = 0, j = 0; i < y.length; i++, j += 4) y[i] = 16 + (kr * px[j] + kg * px[j + 1] + kb * px[j + 2]) * k;
  return { data: y, width, height };
}

/**
 * Esegue (o riprende) la ricerca per i segmenti from..n-1. saved[k] = record già nel manifest → riusato senza prove.
 * deps: {encodeTrial, measure, release?} (createTrialDeps). isFatal(e): errori da NON assorbire (background, annullo).
 * save(k, rec): persiste il record (manifest). check(): attesa primo piano / annullo tra un segmento e l'altro.
 * Ritorna i record per tutti i segmenti (null per quelli < from senza record).
 */
export async function runSceneSearch({ plan, from = 0, saved = {}, deps, ceiling, opts = {}, isFatal = () => false, save = async () => {}, check = async () => {}, log = () => {}, onProgress = () => {}, now = () => Date.now() }) {
  const recs = plan.map((s, k) => saved[k] || null); let fails = 0, off = false;
  const todo = plan.filter((s) => s.k >= from && !saved[s.k]).length; let done = 0;
  if (from < plan.length && todo < plan.length - from) log(`ripresa: prove già fatte per ${plan.length - from - todo} segmenti (dal manifest), da fare ${todo}`);
  for (const seg of plan) {
    if (seg.k < from || recs[seg.k]) continue;
    await check();
    const t0 = now(); let rec;
    if (off) rec = { ...fallbackRecord(ceiling, 'prove disattivate dopo errori ripetuti', 0), why: 'off' };
    else {
      try {
        const res = await searchBitrate({ trialWindow: seg.trialWindow, prior: seg.prior }, deps,
          { ...opts, minBitrate: Math.min(opts.minBitrate ?? SCENE.floor, ceiling), maxBitrate: ceiling });
        rec = toRecord(res, now() - t0); fails = 0;
      } catch (e) {
        if (isFatal(e)) throw e;
        rec = fallbackRecord(ceiling, e, now() - t0); fails++;
        log(`⚠️ scena ${seg.k + 1}: prove fallite (${e?.name || 'errore'}: ${e?.message || e}) → ripiego a ${mb(ceiling)} Mbps per questo segmento`);
        if (fails >= (opts.maxFails ?? SCENE.maxFails)) { off = true; log(`⚠️ ${fails} segmenti di fila senza prove riuscite: per il resto del job uso il bitrate dell'utente`); }
      } finally { try { deps.release?.(); } catch {} }
    }
    recs[seg.k] = rec; await save(seg.k, rec); done++;
    log(`${sceneLine(seg.k, rec)}${rec.ms ? ` · prove ${(rec.ms / 1000).toFixed(1)} s` : ''}`);
    onProgress(done, todo, seg.k);
  }
  return recs;
}

// ---------------------------------------------------------------------------------------------
// Parte browser (WebCodecs + canvas)
// ---------------------------------------------------------------------------------------------

/** Luma via canvas 2D a 1/factor di W×H. Funziona con frame nativi (format null) e con frame di VideoDecoder. */
export function makeCanvasLuma(W, H, factor = SCENE.factor) {
  const w = Math.max(8, Math.floor(W / factor)), h = Math.max(8, Math.floor(H / factor));
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = cv.getContext('2d', { willReadFrequently: true, alpha: false });
  if (!ctx) throw new Error('canvas 2D non disponibile');
  return (frame) => { ctx.drawImage(frame, 0, 0, w, h); return lumaU8FromRGBA(ctx.getImageData(0, 0, w, h).data, w, h); };
}

/**
 * Implementazioni browser di encodeTrial/measure per ratecontrol.searchBitrate.
 *  W,H: dimensioni dei frame nativi; frames: [{ts,dur}] in secondi (index.html);
 *  frameSource(startIdx, endIdx) → async iterable di VideoFrame (seekFrames/parallelFrames, il chiamante li riceve e li chiude QUI);
 *  makeEncoder({width,height,bitrate,onChunk,onError}) → wrapper come encode.createHevcEncoder (encode/drain/flush/close);
 *  colorSpace: VideoColorSpaceInit da forzare sul decoder di prova (HLG come il file finale), facoltativo.
 */
export function createTrialDeps({ W, H, frames, frameSource, makeEncoder, colorSpace, stride = SCENE.stride, factor = SCENE.factor, onStat = () => {} }) {
  const luma = makeCanvasLuma(W, H, factor);
  const cache = new Map(); // finestra → luma sorgente (solo indici multipli di stride)
  const keyOf = (w) => `${w.startIdx}-${w.endIdx}`;
  return {
    async encodeTrial(w, rates) {
      const key = keyOf(w), capture = !cache.has(key), src = capture ? [] : null;
      let durS = 0; for (let i = w.startIdx; i < w.endIdx; i++) durS += frames[i].dur;
      const outs = rates.map((r) => ({ r, chunks: [], bytes: 0, config: null, err: null, enc: null }));
      try {
        for (const o of outs) o.enc = makeEncoder({ width: W, height: H, bitrate: r0(o.r),
          onChunk: (c, meta) => { if (meta?.decoderConfig && !o.config) o.config = meta.decoderConfig; o.chunks.push(c); o.bytes += c.byteLength; },
          onError: (e) => { o.err ||= e; } });
        let j = 0;
        for await (const vf of frameSource(w.startIdx, w.endIdx)) {
          try {
            for (const o of outs) { if (o.err) throw o.err; o.enc.encode(vf, j === 0); }
            if (capture && j % stride === 0) src[j] = luma(vf);
          } finally { vf.close(); }
          j++;
          for (const o of outs) await o.enc.drain(2);
        }
        for (const o of outs) await o.enc.flush();
        for (const o of outs) if (o.err) throw o.err;
        if (j !== w.endIdx - w.startIdx) throw new Error(`prova: ${j} frame su ${w.endIdx - w.startIdx}`);
      } finally { for (const o of outs) { try { o.enc?.close(); } catch {} } }
      if (capture) cache.set(key, src);
      return outs.map((o) => {
        if (!o.config || !o.chunks.length) throw new Error('prova: l\'encoder non ha prodotto pacchetti o decoderConfig');
        const config = { ...o.config, codedWidth: o.config.codedWidth || W, codedHeight: o.config.codedHeight || H };
        if (colorSpace) config.colorSpace = colorSpace;
        onStat({ requested: o.r, bytes: o.bytes, real: o.bytes * 8 / durS });
        return { bitrate: o.bytes * 8 / durS, requested: o.r, bytes: o.bytes, encoded: { chunks: o.chunks, config, n: o.chunks.length } };
      });
    },
    async measure(w, encoded) {
      const src = cache.get(keyOf(w)); if (!src) throw new Error('misura: luma sorgente assente');
      const dbs = [];
      const n = await decodeChunks(encoded.config, encoded.chunks, (f, i) => { if (i % stride === 0 && src[i]) dbs.push(frameScore(src[i], luma(f)).db); });
      encoded.chunks.length = 0; // i chunk di prova non servono più
      if (n !== encoded.n) throw new Error(`misura: decodificati ${n} frame su ${encoded.n}`);
      if (dbs.length < 2) throw new Error('misura: troppo pochi frame confrontati');
      return dbs;
    },
    release() { cache.clear(); },
  };
}
const r0 = (b) => Math.round(b);

/** Stima VMAF da un elenco di ssimDb (per l'autotest di allineamento e il debug). */
export const vmafOf = (dbs) => estimateVmaf(pool(dbs));
