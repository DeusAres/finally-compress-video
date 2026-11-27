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
// v0.35 (research/12 §12) — stesse regole di decisione, molto meno lavoro:
//   · misura IN DIRETTA: il decoder di prova riceve i chunk mentre l'encoder li produce (niente secondo passaggio dopo);
//   · «limite per primo»: se il prior è a ridosso del limite si misura prima il limite; se già lì il VMAF stimato non basta
//     → clamped-max subito (la prova più bassa, codificata in parallelo, non viene misurata);
//   · contenuto facile: discesa prudente (pendenza ≥ standard, ≤ un dimezzamento) senza 2° giro;
//   · partenza a caldo: il prior di k usa il bitrate scelto per k−1; player e via canvas riscaldati prima delle prove (index.html);
//   · riga «prove: tempi …» nel log con la ripartizione (estrazione, luma, SSIM, attese) da misurare sul device.
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
import { searchBitrate, predictBitrate, DEFAULTS as RC } from './ratecontrol.js?v=0.38.2';
import { frameScore, decodeChunks, pool, estimateVmaf } from './quality.js?v=0.38.2';

export const SCENE = Object.freeze({
  targetVmaf: RC.targetVmaf,   // 88 (BIBBIA §12)
  trialSec: 1.0,               // finestra di prova (research/12 §2/§5)
  stride: 2,                   // metrica su un frame ogni 2 (PLCC 0.958 → 0.956, research/12 §2)
  factor: 2,                   // luma a ½ risoluzione (540×960 per 1080×1920)
  floor: 2e6,                  // bitrate minimo (ratecontrol DEFAULTS.minBitrate)
  timeFactor: 1.6,             // tempo totale ≈ 1.6× la sola codifica (v0.35, stima research/12 §12; v0.34.1 misurato ≈ 3× su IMG_3053): UI e barra
  maxFails: 2,                 // dopo N segmenti consecutivi falliti le prove si spengono per il resto del job
  // v0.37.4 — tetto dalla sorgente: target del segmento ≤ srcCap × bitrate della sorgente nel segmento (anche a bitrate fisso).
  // 0.85: ricodificare a ≥ il bitrate della camera non fa risparmiare nulla (stessa codifica HEVC, + perdita di generazione);
  // il controllo a circuito chiuso VT sfora di ~3–5 % (estimate.js 1.03, brctl) e l'overhead di contenitore/audio è uguale
  // nei due file, quindi 0.85 lascia ≥ ~10 % di risparmio garantito sul video anche nel caso peggiore. Più vicino a 1 (0.9)
  // il guadagno è nel rumore dello sforamento; più basso (0.7) si toglie qualità a sorgenti già leggere senza motivo.
  srcCap: 0.85,
  // sorgente intera ≤ keepRatio × target video → non si ricomprime (tenuto l'originale): il tetto sarebbe ≤ 0.85 × sorgente,
  // cioè ≤ ~15 % di risparmio pagato con una seconda generazione HEVC e minuti di codifica.
  keepRatio: 1.1,
  // v0.37.4 — prove saltate: dopo skipAfter segmenti PROVATI di fila finiti al tetto con VMAF stimato < target − skipGap
  // (−4 ≈ servirebbe ≥ 1.3× il tetto, pendenza 10/raddoppio), i segmenti seguenti con bitrate sorgente entro ×skipSim del
  // riferimento (e del segmento prima) usano il tetto senza prove. Sbagliare costa solo bit (tetto al posto di meno), mai qualità.
  skipAfter: 2, skipGap: 4, skipSim: 1.25,
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
/** Tetto del segmento: min(limite utente, srcCap × bitrate sorgente del segmento); senza dimensioni dei pacchetti, il limite. */
export function segmentCap(srcBitrate, ceiling, factor = SCENE.srcCap) {
  return srcBitrate > 0 ? Math.min(ceiling, factor * srcBitrate) : ceiling;
}
/** Tetti per segmento (bit/s) per l'encode a bitrate fisso (stessa regola del piano per scena). */
export function segmentCaps(frames, segStarts, ceiling, factor = SCENE.srcCap) {
  return segStarts.map((a, k) => segmentCap(win(frames, a, k + 1 < segStarts.length ? segStarts[k + 1] : frames.length).srcBitrate, ceiling, factor));
}
/**
 * Conviene ricomprimere? Bitrate video della sorgente intera vs target video dell'utente. keep = true → tenere l'originale
 * (sorgente ≤ keepRatio × target). Senza dimensioni dei pacchetti (srcBps 0) si ricomprime come prima.
 */
export function worthRecompress(srcBps, targetBps, keepRatio = SCENE.keepRatio) {
  const keep = srcBps > 0 && srcBps <= keepRatio * targetBps;
  return { keep, ratio: srcBps > 0 ? srcBps / targetBps : NaN };
}
/** Bitrate video medio della sorgente (bit/s) da [{dur, size}]. */
export function sourceBitrate(frames) { return win(frames, 0, frames.length).srcBitrate; }
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
    const cap = hasSizes ? segmentCap(all.srcBitrate, ceiling, o.srcCap ?? SCENE.srcCap) : ceiling; // v0.37.4: mai oltre 0.85 × sorgente
    const prior = hasSizes && trialWindow.srcBitrate > 0 ? predictBitrate(trialWindow.srcBitrate, { ...RC, minBitrate: Math.min(floor, cap), maxBitrate: cap }) : cap;
    return { k, startIdx, endIdx, duration: all.duration, srcBitrate: all.srcBitrate, trialWindow, prior, cap };
  });
}

const r2 = (x) => Math.round(x * 100) / 100;
const v100 = (q) => r2(Math.min(100, q)); // la taratura è lineare: oltre 100 (contenuti statici/facili) il valore non ha senso, si mostra 100
/** Record compatto salvato nel manifest della ripresa per il segmento (bitrate in bit/s, VMAF stimati). */
export function toRecord(res, ms, priorFrom) {
  const st = res.stats;
  return { b: res.bitrate, why: res.reason, prior: Math.round(res.prior), ...(priorFrom ? { pf: priorFrom } : {}),
    ...(st ? { n: { e: st.encoders, m: st.measures, s: st.streamed, r: res.rounds, ...(st.ceilingFirst ? { cf: 1 } : {}), ...(st.easy ? { ez: 1 } : {}) } } : {}),
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
const WHY = { 'clamped-max': ' (limite = bitrate scelto: la soglia richiederebbe di più)', 'clamped-min': ' (minimo)', searched: '', fallback: ' (prove fallite: bitrate dell\'utente)', off: ' (prove disattivate: bitrate dell\'utente)',
  skipped: ' (prove saltate: i segmenti prima, simili, erano già al limite con VMAF stimato basso)' };
const whyOf = (rec) => (rec.cs && rec.why === 'clamped-max' ? ' (limite = 0.85 × bitrate della sorgente: la soglia richiederebbe di più)'
  : rec.cs && (rec.why === 'fallback' || rec.why === 'off' || rec.why === 'skipped') ? (WHY[rec.why] ?? '').replace(/\)$/, ', tetto 0.85 × sorgente)') : WHY[rec.why] ?? '');
/** Riga di log: «scena n: prove a x/y Mbps → VMAF stimato a/b → scelto z Mbps (reale w Mbps)». */
export function sceneLine(k, rec, real) {
  const tail = real > 0 ? ` (reale ${mb(real)} Mbps)` : '';
  if (!rec.pts?.length) return `scena ${k + 1}: nessuna prova${rec.err ? ` [${rec.err}]` : ''} → ${mb(rec.b)} Mbps${whyOf(rec)}${tail}`;
  const pts = [...rec.pts].sort((a, b) => a.b - b.b);
  return `scena ${k + 1}: prove a ${pts.map((p) => mb(p.b)).join('/')} Mbps → VMAF stimato ${pts.map((p) => p.q.toFixed(1)).join('/')} → scelto ${mb(rec.b)} Mbps${whyOf(rec)}${tail}`;
}

/**
 * Riepilogo: distribuzione (istogramma a passi di 1 Mbps), bitrate min/max/medio (pesato sulla durata), medio reale,
 * VMAF stimato min/medio al bitrate scelto (solo segmenti provati), tempo delle prove.
 * segs: [{duration}], recs: record per segmento (anche null), reals: bit/s reali per segmento (facoltativo).
 */
export function sceneSummary(segs, recs, reals = []) {
  let bd = 0, d = 0, rd = 0, rdd = 0, min = Infinity, max = 0, ms = 0, nFb = 0, nCap = 0, nSkip = 0, nSrc = 0; const q = [], hist = new Map();
  segs.forEach((s, k) => {
    const r = recs[k]; if (!r) return;
    bd += r.b * s.duration; d += s.duration; min = Math.min(min, r.b); max = Math.max(max, r.b); ms += r.ms || 0;
    if (r.why === 'fallback' || r.why === 'off') nFb++; if (r.why === 'clamped-max') nCap++; if (r.why === 'skipped') nSkip++; if (r.cs) nSrc++;
    if (r.est) q.push(r.est.q);
    if (reals[k] > 0) { rd += reals[k] * s.duration; rdd += s.duration; }
    const h = Math.floor(r.b / 1e6); hist.set(h, (hist.get(h) || 0) + 1);
  });
  if (!d) return null;
  const dist = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([h, n]) => `${h}–${h + 1} Mbps ×${n}`).join(' · ');
  return { n: recs.filter(Boolean).length, min, max, mean: bd / d, realMean: rdd ? rd / rdd : 0, dist,
    vmafMin: q.length ? Math.min(...q) : NaN, vmafMean: q.length ? q.reduce((a, b) => a + b, 0) / q.length : NaN, trialS: ms / 1000, fallbacks: nFb, capped: nCap, skipped: nSkip, srcCapped: nSrc };
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
  const capOf = (seg) => Math.min(ceiling, seg.cap ?? ceiling), cs = (seg) => (capOf(seg) < ceiling ? { cs: 1 } : {});
  const sk = skipTracker(opts);
  const todo = plan.filter((s) => s.k >= from && !saved[s.k]).length; let done = 0;
  if (from < plan.length && todo < plan.length - from) log(`ripresa: prove già fatte per ${plan.length - from - todo} segmenti (dal manifest), da fare ${todo}`);
  const tAll = now();
  for (const seg of plan) {
    if (seg.k < from || recs[seg.k]) { if (recs[seg.k]) sk.see(seg, recs[seg.k]); continue; }
    await check();
    const t0 = now(), cap = capOf(seg); let rec;
    if (off) rec = { ...fallbackRecord(cap, 'prove disattivate dopo errori ripetuti', 0), why: 'off', ...cs(seg) };
    else if (sk.skip(seg)) { rec = { b: cap, why: 'skipped', pts: [], est: null, ms: 0, ...cs(seg) }; if (!sk.said) { sk.said = true; log(`prove saltate da qui per i segmenti con bitrate sorgente simile (entro ×${opts.skipSim ?? SCENE.skipSim} di ${mb(sk.ref())} Mbps): ${opts.skipAfter ?? SCENE.skipAfter} segmenti di fila già al limite con VMAF stimato < ${(opts.targetVmaf ?? SCENE.targetVmaf) - (opts.skipGap ?? SCENE.skipGap)} → uso il limite`); } }
    else {
      try {
        const wp = warmPrior(recs[seg.k - 1], cap, opts.minBitrate ?? SCENE.floor, seg.prior);
        const res = await searchBitrate({ trialWindow: seg.trialWindow, prior: Math.min(cap, wp ?? seg.prior) }, deps,
          { ...opts, minBitrate: Math.min(opts.minBitrate ?? SCENE.floor, cap), maxBitrate: cap });
        rec = { ...toRecord(res, now() - t0, wp != null ? 'prev' : 'src'), ...cs(seg) }; fails = 0;
      } catch (e) {
        if (isFatal(e)) throw e;
        rec = { ...fallbackRecord(cap, e, now() - t0), ...cs(seg) }; fails++;
        log(`⚠️ scena ${seg.k + 1}: prove fallite (${e?.name || 'errore'}: ${e?.message || e}) → ripiego a ${mb(cap)} Mbps per questo segmento`);
        if (fails >= (opts.maxFails ?? SCENE.maxFails)) { off = true; log(`⚠️ ${fails} segmenti di fila senza prove riuscite: per il resto del job uso il bitrate dell'utente`); }
      } finally { try { deps.release?.(); } catch {} }
    }
    recs[seg.k] = rec; sk.see(seg, rec); await save(seg.k, rec); done++;
    log(`${sceneLine(seg.k, rec)}${rec.ms ? ` · prove ${(rec.ms / 1000).toFixed(1)} s` : ''}${workNote(rec)}`);
    onProgress(done, todo, seg.k);
  }
  if (done && deps.timing) { try { log(timingLine(deps.timing(), now() - tAll, done)); } catch {} }
  return recs;
}

/**
 * v0.37.4 prove saltate. see(seg, rec) in ordine di segmento; skip(seg) = true se gli ultimi skipAfter segmenti PROVATI sono finiti
 * al tetto (clamped-max) con VMAF stimato < target − skipGap, hanno bitrate sorgente simile fra loro, e seg è entro ×skipSim sia
 * del loro riferimento (media geometrica) sia del segmento subito prima. Un segmento diverso si prova: se non finisce al tetto
 * basso la serie si azzera. Segmenti saltati/falliti non cambiano la serie.
 */
export function skipTracker(opts = {}) {
  const K = opts.skipAfter ?? SCENE.skipAfter, gap = opts.skipGap ?? SCENE.skipGap, sim = opts.skipSim ?? SCENE.skipSim, tq = opts.targetVmaf ?? SCENE.targetVmaf;
  let run = [], prevSrc = 0;
  const near = (a, b) => a > 0 && b > 0 && Math.abs(Math.log(a / b)) <= Math.log(sim);
  const ref = () => (run.length ? Math.exp(run.reduce((a, x) => a + Math.log(x), 0) / run.length) : 0);
  return {
    said: false, ref,
    see(seg, rec) {
      const src = seg.srcBitrate;
      if (rec.why === 'clamped-max' && rec.pts?.length && rec.est && rec.est.q < tq - gap && src > 0) {
        if (run.length && !near(src, ref())) run = []; // serie solo fra segmenti simili
        run.push(src); if (run.length > K) run.shift();
      } else if (rec.why !== 'skipped' && rec.why !== 'fallback' && rec.why !== 'off') run = [];
      prevSrc = src;
    },
    skip(seg) { return K > 0 && run.length >= K && near(seg.srcBitrate, ref()) && near(seg.srcBitrate, prevSrc); },
  };
}

/**
 * v0.35 partenza «a caldo»: il prior del segmento k tiene conto del bitrate scelto per k−1 (stessa clip, misurato), non solo di 0.4 × sorgente
 * (research/12 §4: dentro un clip il bitrate sorgente non predice il necessario, il segmento precedente sì meglio). È solo il
 * CENTRO della prima forchetta: la decisione resta della misura. null → si usa il prior dalla sorgente.
 */
export function warmPrior(prev, ceiling, floor = SCENE.floor, srcPrior = null) {
  if (!prev || !(prev.b > 0) || !['searched', 'clamped-max', 'clamped-min'].includes(prev.why)) return null;
  // clamped-max: il precedente voleva PIÙ del limite → si parte dal limite (prova «limite per primo»); altrimenti media geometrica
  // con il prior dalla sorgente (copre i salti di contenuto tra segmenti), o il solo precedente se il prior manca
  const b = prev.why === 'clamped-max' || !(srcPrior > 0) ? prev.b : Math.sqrt(prev.b * srcPrior);
  return Math.min(ceiling, Math.max(Math.min(floor, ceiling), b));
}
// « · 1 giro, 2 enc/1 misura, limite prima» — quanto lavoro ha fatto la ricerca del segmento (record.n)
function workNote(rec) {
  const n = rec.n; if (!n) return '';
  return ` · (${n.r} ${n.r === 1 ? 'giro' : 'giri'}, ${n.e} enc/${n.m} ${n.m === 1 ? 'misura' : 'misure'}${n.s ? `, ${n.s} in diretta` : ''}${n.cf ? ', limite per primo' : ''}${n.ez ? ', facile: niente 2° giro' : ''}${rec.pf === 'prev' ? ', partenza dal segmento prima' : ''})`;
}
const sec = (ms) => (ms / 1000).toFixed(2);
/**
 * Riga compatta di ripartizione dei tempi delle prove (v0.35, da leggere nel log del device):
 * T = createTrialDeps().timing(): ms per voce + conteggi. «altro» = totale − somma delle voci misurate in serie.
 */
export function timingLine(T, totalMs, nSeg) {
  const serial = T.extract + T.lumaSrc + T.encWait + T.decWait + T.lumaDec + T.ssim + T.setup + T.liveTail;
  return `prove: tempi ${sec(totalMs)} s per ${nSeg} segmenti · estrazione ${sec(T.extract)} s (${T.frames} frame, ${T.players || '?'} player; include la misura in diretta) · luma sorgente ${sec(T.lumaSrc)} s (${T.nSrc}) · attese encoder ${sec(T.encWait)} s · avvio enc/dec ${sec(T.setup)} s`
    + ` · misura in diretta: luma ${sec(T.lumaLive)} s (${T.nLive}) + SSIM ${sec(T.ssimLive)} s, coda ${sec(T.liveTail)} s`
    + ` · misura dopo: decode attese ${sec(T.decWait)} s, luma ${sec(T.lumaDec)} s (${T.nDec}), SSIM ${sec(T.ssim)} s`
    + ` · altro ${sec(Math.max(0, totalMs - serial))} s${T.liveOff ? ` · misura in diretta disattivata (${T.liveOff})` : ''}`;
}

/** Riga di log dell'autotest luma (v0.35.2): «prove: luma via canvas GPU|CPU — autotest SSIM CPU a/b dB · GPU c/d dB (Δ max x) · CPU n ms · GPU m ms». */
export function lumaTestLine(lc) {
  const f2 = (v) => v.map((x) => x.toFixed(2)).join('/'), ms = (x) => (x >= 10 ? Math.round(x) : x.toFixed(1));
  const head = `prove: luma via canvas ${lc.path === 'gpu' ? 'GPU' : 'CPU'}`;
  const parts = [];
  if (lc.cpu?.length) parts.push(`autotest SSIM CPU ${f2(lc.cpu)} dB · GPU ${f2(lc.gpu)} dB${Number.isFinite(lc.delta) ? ` (Δ max ${lc.delta.toFixed(2)})` : ''}`);
  if (Number.isFinite(lc.cpuMs)) parts.push(`CPU ${ms(lc.cpuMs)} ms · GPU ${ms(lc.gpuMs)} ms`);
  if (lc.path !== 'gpu' && lc.reason) parts.push(lc.reason);
  return parts.length ? `${head} — ${parts.join(' · ')}` : head;
}

// ---------------------------------------------------------------------------------------------
// Parte browser (WebCodecs + canvas)
// ---------------------------------------------------------------------------------------------

/** Luma via canvas 2D a 1/factor di W×H. Funziona con frame nativi (format null) e con frame di VideoDecoder. */
export function makeCanvasLuma(W, H, factor = SCENE.factor, { gpu = false } = {}) {
  const w = Math.max(8, Math.floor(W / factor)), h = Math.max(8, Math.floor(H / factor));
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = cv.getContext('2d', { willReadFrequently: !gpu, alpha: false }); // gpu: banco di misura (v0.35) e prove se l'autotest a coppie lo consente (v0.35.2, autotestLuma)
  if (!ctx) throw new Error('canvas 2D non disponibile');
  return (frame) => { ctx.drawImage(frame, 0, 0, w, h); return lumaU8FromRGBA(ctx.getImageData(0, 0, w, h).data, w, h); };
}

/**
 * Implementazioni browser di encodeTrial/measure per ratecontrol.searchBitrate.
 *  W,H: dimensioni dei frame nativi; frames: [{ts,dur}] in secondi (index.html);
 *  frameSource(startIdx, endIdx) → async iterable di VideoFrame (seekFrames/parallelFrames, il chiamante li riceve e li chiude QUI);
 *  skipFrame(vf) → true per i frame non verificati (v0.36.3): codificati ma esclusi dalla metrica;
 *  makeEncoder({width,height,bitrate,framerate,onChunk,onError}) → wrapper come encode.createHevcEncoder (encode/drain/flush/close);
 *  colorSpace: VideoColorSpaceInit da forzare sul decoder di prova (HLG come il file finale), facoltativo.
 *  encW/encH (default W/H): dimensioni dell'encoder se diverse dai frame nativi (v0.31 «Riduci a 1080p»); verifyOutput(decoderConfig): lancia se l'uscita non è quella chiesta.
 *  makeDecoder(init) (default new VideoDecoder), lumaFn, gpuLumaFn (luma GPU per autotestLuma), decodeFn: iniettabili per i test; live (default true): misura in diretta (v0.35).
 *
 * v0.35 «misura in diretta»: per i bitrate con stream[i] (ratecontrol: quelli da misurare subito) un VideoDecoder riceve i chunk
 * MENTRE l'encoder di prova li produce; luma (stessa funzione canvas) + SSIM del frame decodificato i contro la luma sorgente i
 * (catturata nel ciclo prima di encode(i), quindi sempre già pronta). La misura finisce quasi insieme alla prova invece di
 * richiedere un secondo passaggio (decode + canvas) dopo: la parte lenta (readback del canvas) si sovrappone alle attese del
 * seek/rVFC. Solo encoder e decoder DI PROVA (l'encoder finale non esiste ancora, research/12 §7.9). Qualsiasi errore del
 * decoder in diretta → i chunk sono ancora lì e si misura dopo come prima (measure); se il decoder non si crea/configura,
 * la diretta si spegne per il resto del job.
 */
export function createTrialDeps({ W, H, frames, frameSource, skipFrame = () => false, makeEncoder, colorSpace, stride = SCENE.stride, factor = SCENE.factor, onStat = () => {}, encW = W, encH = H, framerate, verifyOutput,
  makeDecoder = (init) => new VideoDecoder(init), live = true, now = () => performance.now(), players = () => 0, lumaFn = null, gpuLumaFn = null, decodeFn = decodeChunks }) {
  // «Riduci a 1080p»: W×H = frame nativi (4K), encW×encH = dimensioni dell'encoder. La luma si prende SEMPRE a 1/factor di encW×encH:
  // sorgente 4K (drawImage ridimensiona) e frame decodificato 1080p finiscono nella stessa griglia → confronto a risoluzione comune.
  let luma = lumaFn ?? makeCanvasLuma(encW, encH, factor); // lumaFn/decodeFn/makeDecoder: solo per i test in Node
  let lumaPath = 'cpu';
  const cache = new Map(); // finestra → luma sorgente (solo indici multipli di stride)
  const keyOf = (w) => `${w.startIdx}-${w.endIdx}`;
  const T = { extract: 0, frames: 0, players: 0, lumaSrc: 0, nSrc: 0, encWait: 0, setup: 0, decWait: 0, lumaDec: 0, nDec: 0, ssim: 0, lumaLive: 0, nLive: 0, ssimLive: 0, liveTail: 0, liveOff: '' };
  let liveOn = !!live;
  const decConfig = (c) => { const config = { ...c, codedWidth: c.codedWidth || encW, codedHeight: c.codedHeight || encH }; if (colorSpace) config.colorSpace = colorSpace; return config; };
  // misura in diretta di un'uscita di prova: decoder creato al primo chunk (serve il decoderConfig), frame → luma → SSIM
  const startLive = (src) => {
    const L = { dec: null, dbs: [], idx: 0, chain: Promise.resolve(), err: null };
    L.feed = (chunk, config) => {
      if (L.err) return;
      try {
        if (!L.dec) {
          const t = now();
          L.dec = makeDecoder({
            output: (f) => { const i = L.idx++; L.chain = L.chain.then(() => {
              if (i % stride || !src[i]) return;
              let t0 = now(); const d = luma(f); T.lumaLive += now() - t0; T.nLive++;
              t0 = now(); L.dbs[i / stride] = frameScore(src[i], d).db; T.ssimLive += now() - t0;
            }).catch((e) => { L.err ||= e; }).finally(() => f.close()); },
            error: (e) => { L.err ||= e; } });
          L.dec.configure(decConfig(config));
          T.setup += now() - t;
        }
        L.dec.decode(chunk);
      } catch (e) {
        L.err ||= e;
        if (!L.dec || L.dec.state === 'unconfigured') { liveOn = false; T.liveOff ||= String(e?.message || e).slice(0, 80); } // decoder non creabile insieme agli encoder: diretta spenta
      }
    };
    L.finish = async (n) => { // dopo il flush degli encoder: ritorna dbs o null (→ misura dopo)
      const t = now();
      try { if (L.dec && !L.err) await L.dec.flush(); } catch (e) { L.err ||= e; }
      await L.chain;
      T.liveTail += now() - t;
      L.close();
      if (L.err && L.idx === 0 && liveOn) { liveOn = false; T.liveOff ||= String(L.err?.message || L.err).slice(0, 80); } // il decoder non ha mai dato frame: diretta spenta per il job
      const dbs = L.dbs.filter((x) => Number.isFinite(x));
      return !L.err && L.idx === n && dbs.length >= 2 ? dbs : null;
    };
    L.close = () => { try { if (L.dec && L.dec.state !== 'closed') L.dec.close(); } catch {} };
    return L;
  };
  return {
    /** encodeTrial(w, rates, {stream}) → [{bitrate, requested, bytes, encoded, dbs?}] (dbs = misura in diretta riuscita). */
    async encodeTrial(w, rates, { stream = [] } = {}) {
      const key = keyOf(w), capture = !cache.has(key), src = capture ? [] : cache.get(key);
      let durS = 0; for (let i = w.startIdx; i < w.endIdx; i++) durS += frames[i].dur;
      const outs = rates.map((r, i) => ({ r, chunks: [], bytes: 0, config: null, err: null, enc: null, live: stream[i] && liveOn ? startLive(src) : null }));
      try {
        let t = now();
        for (const o of outs) o.enc = makeEncoder({ width: encW, height: encH, framerate, bitrate: r0(o.r),
          onChunk: (c, meta) => {
            if (meta?.decoderConfig && !o.config) {
              o.config = meta.decoderConfig;
              if (o.live) { try { verifyOutput?.(o.config); } catch (e) { o.err ||= e; o.live.close(); o.live = null; } } // downscale errato: fatale, niente diretta
            }
            o.chunks.push(c); o.bytes += c.byteLength;
            if (o.live && o.config) o.live.feed(c, o.config);
          },
          onError: (e) => { o.err ||= e; } });
        T.setup += now() - t;
        let j = 0; t = now();
        for await (const vf of frameSource(w.startIdx, w.endIdx)) {
          T.extract += now() - t;
          try {
            for (const o of outs) { if (o.err) throw o.err; o.enc.encode(vf, j === 0); }
            // v0.36.3: frame non verificato (skipFrame, frames.isUnverified): niente luma sorgente → escluso dalla metrica
            if (capture && j % stride === 0 && !skipFrame(vf)) { const t0 = now(); src[j] = luma(vf); T.lumaSrc += now() - t0; T.nSrc++; }
          } finally { vf.close(); }
          j++; T.frames++;
          const t1 = now(); for (const o of outs) await o.enc.drain(2); T.encWait += now() - t1;
          t = now();
        }
        T.players = Math.max(T.players, players() || 0);
        const t2 = now(); for (const o of outs) await o.enc.flush(); T.encWait += now() - t2;
        for (const o of outs) if (o.err) throw o.err;
        if (j !== w.endIdx - w.startIdx) throw new Error(`prova: ${j} frame su ${w.endIdx - w.startIdx}`);
      } catch (e) { for (const o of outs) o.live?.close(); throw e; }
      finally { for (const o of outs) { try { o.enc?.close(); } catch {} } }
      if (capture) cache.set(key, src);
      const res = [];
      try {
        for (const o of outs) {
          if (!o.config || !o.chunks.length) throw new Error('prova: l\'encoder non ha prodotto pacchetti o decoderConfig');
          verifyOutput?.(o.config); // downscale: dimensioni/10 bit dell'uscita (errore fatale, mai assorbito dalle prove)
          const dbs = o.live ? await o.live.finish(o.chunks.length) : null;
          onStat({ requested: o.r, bytes: o.bytes, real: o.bytes * 8 / durS, live: !!dbs });
          const encoded = { chunks: dbs ? [] : o.chunks, config: decConfig(o.config), n: o.chunks.length }; // misurata in diretta: chunk liberati subito
          res.push({ bitrate: o.bytes * 8 / durS, requested: o.r, bytes: o.bytes, encoded, ...(dbs ? { dbs } : {}) });
        }
      } finally { for (const o of outs) o.live?.close(); } // nessun decoder di prova sopravvive alla chiamata
      return res;
    },
    async measure(w, encoded) {
      const src = cache.get(keyOf(w)); if (!src) throw new Error('misura: luma sorgente assente');
      const dbs = []; let tIn = 0;
      const t = now();
      const n = await decodeFn(encoded.config, encoded.chunks, (f, i) => {
        if (i % stride !== 0 || !src[i]) return;
        let t0 = now(); const d = luma(f); const t1 = now(); T.lumaDec += t1 - t0; T.nDec++;
        dbs.push(frameScore(src[i], d).db); const t2 = now(); T.ssim += t2 - t1; tIn += t2 - t0;
      });
      T.decWait += now() - t - tIn;
      encoded.chunks.length = 0; // i chunk di prova non servono più
      if (n !== encoded.n) throw new Error(`misura: decodificati ${n} frame su ${encoded.n}`);
      if (dbs.length < 2) throw new Error('misura: troppo pochi frame confrontati');
      return dbs;
    },
    /** Riscalda la via canvas (primo drawImage di un frame nativo HLG: shader/conversione) prima delle prove. */
    warm(vf) { const t = now(); luma(vf); T.setup += now() - t; },
    /**
     * v0.35 banco di misura (solo log, nessuna scelta automatica): ms mediani per frame della luma attuale (½, canvas CPU
     * willReadFrequently) e di due alternative non adottate (½ su canvas GPU, ¼ su canvas CPU) sullo stesso frame nativo.
     * Serve a decidere sul device se la lettura del canvas è il collo di bottiglia (research/12 §12).
     */
    bench(vf, reps = 3) {
      const med = (fn) => { const v = []; for (let i = 0; i < reps; i++) { const t = now(); fn(vf); v.push(now() - t); } v.sort((a, b) => a - b); return v[v.length >> 1]; };
      const out = { half: med(luma) };
      try { out.halfGpu = med(makeCanvasLuma(encW, encH, factor, { gpu: true })); } catch { out.halfGpu = NaN; }
      try { out.quarter = med(makeCanvasLuma(encW, encH, factor * 2)); } catch { out.quarter = NaN; }
      try { const a = luma(vf); const t = now(); for (let i = 0; i < reps; i++) frameScore(a, a); out.ssim = (now() - t) / reps; } catch { out.ssim = NaN; }
      return out;
    },
    /**
     * v0.35.2 autotest a coppie (sostituisce chooseLuma v0.35.1). Su iPhone la luma da canvas CPU (willReadFrequently) costa
     * 72 ms/frame a 1080p e 289 ms con sorgente 4K, da canvas GPU 8–19 ms: è il collo di bottiglia delle prove. La luma GPU NON
     * coincide con la CPU in assoluto (IMG_1418 4K: differenza media 2.6 livelli, max 76: tone mapping/dither diversi) e non serve:
     * serve che tratti in modo COERENTE frame nativo e frame decodificato, cioè che la ssimDb misurata via GPU sia quella via CPU,
     * su cui è tarata la mappatura ssimDb→VMAF (research/12 §3: ~4.1 VMAF per dB d'intercetta).
     * Prova: il frame nativo di riscaldamento viene codificato come keyframe (stesso makeEncoder/verifyOutput delle prove) a
     * ciascun bitrate di `rates` (es. limite e limite/3), decodificato (colorSpace forzato come nelle prove) e confrontato con
     * la sorgente sia via CPU sia via GPU: GPU se |Δ ssimDb| ≤ maxDelta su TUTTE le coppie ed è più veloce.
     * maxDelta 0.3 dB ≈ 1.2 VMAF stimati: metà dello s.d. residuo della taratura (2.48) e meno di metà del margine +1 s.d.
     * già nel bersaglio; un errore più grande sposterebbe il bitrate scelto di ≳ 10 % (pendenza ~10 VMAF per raddoppio).
     * Encoder e decoder sempre chiusi (finally), uno alla volta, prima di qualsiasi prova. Errori fatali (isFatal: downscale non
     * riuscito, annullamento) rilanciati; ogni altro errore → resta la CPU con il motivo. Da chiamare PRIMA delle prove.
     */
    async autotestLuma(vf, rates, { maxDelta = 0.3, reps = 3, isFatal = (e) => ['DownscaleError', 'Cancelled', 'BackgroundInterrupt'].includes(e?.name) } = {}) {
      if (cache.size) return { path: lumaPath, reason: 'fisso (prove già iniziate)' };
      let gpu; try { gpu = gpuLumaFn ?? makeCanvasLuma(encW, encH, factor, { gpu: true }); } catch (e) { return { path: lumaPath, reason: `GPU non disponibile (${e?.message || e})` }; }
      const out = { path: lumaPath, cpu: [], gpu: [], delta: NaN, cpuMs: NaN, gpuMs: NaN };
      const med = (fn, f) => { const v = []; let r; for (let i = 0; i < reps; i++) { const t = now(); r = fn(f); v.push(now() - t); } v.sort((x, y) => x - y); return { ms: v[v.length >> 1], r }; };
      try {
        const c = med(luma, vf), g = med(gpu, vf); out.cpuMs = c.ms; out.gpuMs = g.ms;
        for (const r of rates) {
          // 1) un keyframe codificato con lo stesso encoder delle prove (encoder chiuso prima di creare il decoder)
          const chunks = []; let config = null, err = null, enc = null;
          try {
            enc = makeEncoder({ width: encW, height: encH, framerate, bitrate: r0(r),
              onChunk: (ch, meta) => { if (meta?.decoderConfig && !config) config = meta.decoderConfig; chunks.push(ch); },
              onError: (e) => { err ||= e; } });
            enc.encode(vf, true);
            await enc.flush();
            if (err) throw err;
          } finally { try { enc?.close(); } catch {} }
          if (!config || !chunks.length) throw new Error('nessun pacchetto o decoderConfig');
          verifyOutput?.(config); // downscale errato: fatale come nelle prove
          // 2) decodifica + luma CPU e GPU dello stesso frame decodificato
          let dec = null, derr = null, n = 0, chain = Promise.resolve(), dbC = NaN, dbG = NaN;
          try {
            dec = makeDecoder({ output: (f) => { const i = n++; chain = chain.then(() => { if (i > 0) return; dbC = frameScore(c.r, luma(f)).db; dbG = frameScore(g.r, gpu(f)).db; }).catch((e) => { derr ||= e; }).finally(() => f.close()); },
              error: (e) => { derr ||= e; } });
            dec.configure(decConfig(config));
            for (const ch of chunks) dec.decode(ch);
            await dec.flush();
            await chain;
          } finally { try { if (dec && dec.state !== 'closed') dec.close(); } catch {} }
          if (derr) throw derr;
          if (!Number.isFinite(dbC) || !Number.isFinite(dbG)) throw new Error('nessun frame decodificato');
          out.cpu.push(dbC); out.gpu.push(dbG);
        }
        out.delta = Math.max(...out.cpu.map((x, i) => Math.abs(x - out.gpu[i])));
      } catch (e) {
        if (isFatal(e)) throw e;
        return { ...out, reason: `autotest non riuscito (${String(e?.message || e).slice(0, 80)})` };
      }
      const ok = out.delta <= maxDelta && out.gpuMs < out.cpuMs;
      if (ok) { luma = gpu; lumaPath = 'gpu'; }
      return { ...out, path: lumaPath, reason: ok ? 'SSIM coerente e più veloce' : !(out.delta <= maxDelta) ? `Δ SSIM > ${maxDelta} dB` : 'GPU non più veloce' };
    },
    timing: () => ({ ...T }),
    release() { cache.clear(); },
  };
}
const r0 = (b) => Math.round(b);

/** Stima VMAF da un elenco di ssimDb (per l'autotest di allineamento e il debug). */
export const vmafOf = (dbs) => estimateVmaf(pool(dbs));
