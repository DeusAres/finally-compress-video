// Frame-exact 10-bit frame source for Safari iOS.
// Validated on device (research/02 §10, run 9): seek + 'seeked' + new VideoFrame(video)
// yields native HLG frames (format null), distinct, ~5 ms per seek.
// VideoDecoder would downconvert to NV12 8-bit; GPU canvas would give BGRA 8-bit.

/** Errore di interruzione volontaria (pagina andata in background): non è un guasto, la run si riprende dall'ultimo segmento. */
export const interruptError = () => Object.assign(new Error('interrotto: pagina in background'), { name: 'BackgroundInterrupt' });

// Attende un evento; con `signal` esce subito ('abort') invece di aspettare il timeout.
export const waitEvent = (el, ev, ms, signal) => new Promise((res) => {
  if (signal?.aborted) return res('abort');
  let t = 0;
  const done = (v) => { clearTimeout(t); el.removeEventListener(ev, onEv); signal?.removeEventListener('abort', onAb); res(v); };
  const onEv = () => done(ev), onAb = () => done('abort');
  t = setTimeout(() => done('timeout'), ms);
  el.addEventListener(ev, onEv, { once: true }); signal?.addEventListener('abort', onAb, { once: true });
});

export const RVFC_GRACE_MS = 60;
export const SEEK_TIMEOUT_MS = 4000; // solo per guasti reali: il passaggio in background interrompe via AbortSignal
let seekTimeoutMs = SEEK_TIMEOUT_MS;
/** Solo per i test in Node: timeout di seek più corto. */
export const _setSeekTimeout = (ms) => { seekTimeoutMs = ms || SEEK_TIMEOUT_MS; };

/** v0.36.2: player bloccato (seek senza 'seeked' dopo un nuovo tentativo, metadati che non arrivano): recuperabile ricreando il <video>. */
export const seekTimeoutError = (msg) => Object.assign(new Error(msg), { name: 'SeekTimeout' });
export const isSeekTimeout = (e) => e?.name === 'SeekTimeout';

/**
 * Apre (o RIAPRE, v0.36.2) un <video> di seek fuori dal DOM sul File. `reuse`: elemento già creato da riusare (coda: gli stessi 2
 * player per tutta la sessione invece di 2 nuovi per voce; su iOS un <video> scartato tiene il suo player/decoder finché il GC
 * non lo raccoglie, research/16 §3). Su errore l'elemento è rilasciato (senza src) e resta riusabile.
 */
export async function openVideoElement(file, signal, reuse = null) {
  const v = reuse || document.createElement('video');
  if (reuse) releaseVideoElement(v); // sorgente precedente (se ancora presente) rilasciata prima della nuova
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.src = URL.createObjectURL(file);
  try {
    if (v.readyState < 1) {
      const ev = await waitEvent(v, 'loadedmetadata', 10000, signal);
      if (ev === 'abort') throw interruptError();
      if (ev === 'timeout' && v.readyState < 1) throw seekTimeoutError(`video: metadati non caricati in 10 s (readyState ${v.readyState}, networkState ${v.networkState}${v.error ? ', errore ' + v.error.code : ''})`);
    }
    // Safari needs a decoded frame before seeks deliver pictures reliably.
    let onAb = null, t = 0; // v0.35.4: listener tolto dopo la gara (prima restava sul signal della run, con la sua closure)
    try {
      // v0.36.2: play() può restare in sospeso per sempre se iOS non concede il decoder: dopo 3 s si prosegue (i seek lo diranno)
      await Promise.race([v.play(), new Promise((res) => { t = setTimeout(res, 3000); }), new Promise((_, rej) => { if (signal?.aborted) rej(interruptError()); else signal?.addEventListener('abort', onAb = () => rej(interruptError()), { once: true }); })]);
      v.pause();
    } catch (e) { if (e?.name === 'BackgroundInterrupt') throw e; /* muted autoplay may still be refused; seeks work anyway */ }
    finally { clearTimeout(t); if (onAb) signal.removeEventListener('abort', onAb); }
  } catch (e) { releaseVideoElement(v); throw e; }
  return v;
}

/** Statistiche di verifica per un player (rVFC/mediaTime come vstats). */
export const newStats = () => ({ n: 0, dup: 0, off: 0, noCallback: 0, retried: 0, samples: [], prevMT: null });

/**
 * Estrae UN frame: rVFC richiesto PRIMA del seek, attesa 'seeked', controllo mediaTime (se `ps` è dato), poi new VideoFrame(video).
 * Ritorna {vf, bad, mt}: bad = mediaTime assente/doppione/fuori posto (il frame è comunque creato; decide il chiamante).
 * v0.36.3: `frac` = punto del seek dentro l'intervallo del frame (0.5 = centro; i nuovi tentativi guidati dal mediaTime lo spostano);
 * l'intervallo è `span` (vedi withSpan) e non più `dur`: con VFR/riordino la durata del campione può superare la distanza dal frame
 * successivo. «Fuori posto» ora vale anche per il frame SUCCESSIVO: prima il limite ts+dur+2 ms lo accettava (mt = ts del successivo).
 */
async function grabFrame(video, f, ps, signal, frac = 0.5) {
  const span = spanOf(f), target = (f.ts + span * frac) / 1e6;
  // v0.35: dopo i 250 ms si concede ancora RVFC_GRACE_MS: se il thread principale era occupato (primo drawImage HLG, configure
  // degli encoder di prova…) il timer scaduto passa prima del passo di rendering in cui gira la callback rVFC → falso «assente».
  const pr = ps ? new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    const t = setTimeout(() => setTimeout(() => fin(null), RVFC_GRACE_MS), 250);
    video.requestVideoFrameCallback((_, md) => { clearTimeout(t); fin(md.mediaTime); });
  }) : null;
  if (signal?.aborted) throw interruptError();
  video.currentTime = target;
  let ev = await waitEvent(video, 'seeked', seekTimeoutMs, signal);
  if (ev === 'abort') throw interruptError(); // background: esce subito, senza aspettare il timeout
  if (ev === 'timeout') { // guasto reale (pagina visibile): un solo nuovo tentativo
    video.currentTime = target + 1e-6; ev = await waitEvent(video, 'seeked', seekTimeoutMs, signal);
    if (ev === 'abort') throw interruptError();
    if (ev === 'timeout') throw seekTimeoutError(`seek timeout @${target.toFixed(3)}s`);
    if (ps) ps.retried++;
  }
  let bad = false, mt = null;
  if (ps) {
    mt = await pr; ps.n++;
    if (mt == null) { ps.noCallback++; bad = true; }
    else {
      if (ps.prevMT != null && Math.abs(mt - ps.prevMT) < 1e-4) { ps.dup++; bad = true; }
      if (isOff(f, mt)) { ps.off++; bad = true; if (ps.samples.length < 5) ps.samples.push([+(f.ts / 1e6).toFixed(4), +mt.toFixed(4)]); }
      ps.prevMT = mt;
    }
  }
  return { vf: new VideoFrame(video, { timestamp: f.ts, duration: f.dur }), bad, mt };
}

/** Intervallo di presentazione del frame (µs): `span` se calcolato da withSpan, altrimenti la durata del campione. */
const spanOf = (f) => (f.span > 0 ? f.span : f.dur);
/** mediaTime fuori dal frame atteso: prima di ts (−2 ms) o oltre metà dell'intervallo (cioè più vicino al frame successivo). */
const isOff = (f, mt) => mt < f.ts / 1e6 - 2e-3 || mt > (f.ts + Math.max(spanOf(f) / 2, 2000)) / 1e6;

/**
 * v0.36.3: aggiunge a ogni frame `span` = min(dur, ts del successivo − ts). La durata del demuxer è quella del campione in ordine
 * di DECODIFICA (stts), assegnata al frame dopo l'ordinamento per presentazione: con VFR (durate 32/33/35/42 ms) e riordino può
 * superare la distanza reale dal frame successivo, e il centro ts+dur/2 cadere al confine o nel frame dopo.
 */
export function withSpan(frames) {
  return frames.map((f, i) => {
    const g = i + 1 < frames.length ? frames[i + 1].ts - f.ts : 0;
    return g > 0 && g < f.dur ? { ...f, span: g } : f;
  });
}

/** Sposta il player lontano dal frame (precedente, o successivo per il primo; `far`: ~0.5 s, riparte dal keyframe) e attende la presentazione. */
async function nudge(video, f, signal, far = false) {
  const d = spanOf(f);
  let t = far ? (f.ts > 600000 ? f.ts - 500000 : f.ts + 500000) : f.ts > d ? f.ts - d / 2 : f.ts + 1.5 * d;
  t /= 1e6; if (far && video.duration > 0 && t > video.duration - 0.05) t = Math.max(0, f.ts / 1e6 - 0.5);
  const rv = new Promise((res) => { const to = setTimeout(res, 150); video.requestVideoFrameCallback(() => { clearTimeout(to); res(); }); });
  if (signal?.aborted) throw interruptError();
  video.currentTime = t;
  const ev = await waitEvent(video, 'seeked', seekTimeoutMs, signal);
  if (ev === 'abort') throw interruptError();
  await rv;
}

/**
 * v0.35 riscaldamento dei player prima delle prove per scena: ogni player estrae (con verifica rVFC) un frame che NON è tra i
 * primi che gli verranno chiesti (stesso istante = nessuna nuova presentazione = rVFC che non scatta). Fino a `tries` tentativi.
 * frameFor(p) → {ts, dur} in µs, o null per saltare. keep(p, vf): facoltativo, riceve il frame (ne diventa proprietario);
 * altrimenti il frame è chiuso. Ritorna per player {ok, tries, ms, mt}.
 */
export async function warmPlayers(videos, frameFor, signal = null, { tries = 4, keep = null, reopen = null, onReopen = () => {} } = {}) {
  // v0.35.4: si attendono TUTTI i player prima di consegnare (keep) o di lanciare l'errore: con Promise.all un player che
  // falliva faceva uscire il chiamante mentre l'altro poteva ancora consegnare un VideoFrame che nessuno avrebbe chiuso.
  const got = [];
  const rs = await Promise.allSettled(videos.map(async (v, p) => {
    const f = frameFor(p), t0 = performance.now(); if (!f) return { ok: false, tries: 0, ms: 0, skipped: true };
    const ps = newStats(); let k = 0, r = null;
    const grab = reopenGrab(() => v, (x) => { v = x; }, p, reopen, onReopen, ps, 1); // v0.36.2: player bloccato → ricreato una volta
    for (; k < tries; k++) {
      if (k) await nudge(v, f, signal);
      r = await grab(f, signal);
      if (!r.bad) break;
      r.vf.close(); r = null;
    }
    if (r) { if (keep) got.push([p, r.vf]); else r.vf.close(); }
    return { ok: !!r, tries: Math.min(k + 1, tries), ms: performance.now() - t0, mt: r?.mt ?? null };
  }));
  const bad = rs.find((x) => x.status === 'rejected');
  if (bad) { for (const [, vf] of got) { try { vf.close(); } catch {} } throw bad.reason; }
  for (const [p, vf] of got) keep(p, vf);
  return rs.map((x) => x.value);
}

/**
 * Yields VideoFrames for the given source timestamps (microseconds, from the demuxer).
 * Seeks to the centre of each frame so VFR (17/33 ms) frames are hit exactly once.
 * Caller MUST close() every frame.
 * v0.36.3: con `stats` ogni frame è VERIFICATO (verifiedGrab): un frame non verificabile non viene mai consegnato in silenzio.
 * Opzioni: onBad 'fail' (default: errore FramesUnverified) | 'mark' (prove per scena: consegnato e segnato, isUnverified(vf));
 * budget {reopens, max}: ricreazioni del <video> per frame non verificati, condivise dal chiamante (job); reopenBad false: nessuna;
 * base: indice del primo frame (solo per i messaggi).
 */
export async function* seekFrames(video, frames /* [{ts, dur}] in µs, presentation order */, stats = null, signal = null, { reopen = null, onReopen = () => {}, budget = null, onBad = 'fail', reopenBad = true, base = 0 } = {}) {
  // stats (optional): verify via rVFC which frame was actually presented after each seek.
  if (stats) { stats.retried ||= 0; stats.prevMT ??= null; }
  frames = withSpan(frames);
  const grab = verifiedGrab({ get: () => video, set: (v) => { video = v; }, p: 0, reopen, onReopen, stats, budget: reopenBad ? budget : { reopens: 0, max: 0 }, onBad });
  for (let i = 0; i < frames.length; i++) yield (await grab(frames[i], signal, base + i)).vf;
}

/**
 * v0.36.2 recupero del seek bloccato: se il player va in timeout (già dopo il suo nuovo tentativo interno) l'elemento viene
 * RICREATO con reopen(p) → nuovo <video> e lo stesso frame riprovato UNA volta; un secondo timeout sullo stesso frame (o più di
 * `max` ricreazioni nella stessa estrazione) è un guasto reale e viene rilanciato. Senza reopen: comportamento di prima.
 */
export const MAX_REOPEN = 2;
function reopenGrab(get, set, p, reopen, onReopen, stats, max = MAX_REOPEN) {
  let n = 0;
  return async (f, signal, frac) => {
    try { return await grabFrame(get(), f, stats, signal, frac); }
    catch (e) {
      if (!reopen || !isSeekTimeout(e) || n >= max || signal?.aborted) throw e;
      n++; onReopen(p, e, n);
      const v = await reopen(p); set(v); if (stats) stats.prevMT = null;
      return await grabFrame(v, f, stats, signal, frac);
    }
  };
}

/** v0.36.3: nuovi seek guidati per frame non verificato, prima di ricreare il <video> (l'ultimo dopo uno spostamento di ~0.5 s). */
export const MAX_BAD_TRIES = 3;
/** v0.36.3: ricreazioni del <video> per frame non verificati (default per estrazione; il job ne passa uno condiviso con `budget`). */
export const MAX_BAD_REOPEN = 3;
export const framesUnverifiedError = (msg) => Object.assign(new Error(msg), { name: 'FramesUnverified' });
const unverified = new WeakSet();
/** Frame consegnato SENZA verifica (solo onBad 'mark', prove per scena): da escludere dalla metrica. */
export const isUnverified = (vf) => unverified.has(vf);
const desc = (f, mt) => `mediaTime ${mt == null ? 'assente' : mt.toFixed(4)}, atteso ${(f.ts / 1e6).toFixed(4)}`;
// punto del nuovo seek dentro il frame, guidato dal mediaTime dell'ultimo tentativo: presentato un frame PRECEDENTE → più avanti,
// SUCCESSIVO → più indietro; assente/doppione → piccoli spostamenti attorno al centro (stesso istante = nessuna nuova presentazione)
const steer = (f, mt, j) => {
  const a = [0.7, 0.85, 0.9][Math.min(j, 3) - 1];
  if (mt == null) return [0.5, 0.35, 0.65][(j - 1) % 3];
  if (mt < f.ts / 1e6 - 2e-3) return a;
  if (isOff(f, mt)) return 1 - a;
  return [0.4, 0.6, 0.5][(j - 1) % 3];
};
// quale tentativo tenere se nessuno è verificato: il più vicino al frame atteso (assente = mezzo frame)
const score = (f, r) => (!r.bad ? -1 : r.mt == null ? 0.5 : Math.abs(r.mt - f.ts / 1e6) / (spanOf(f) / 1e6));

/**
 * v0.36.3 estrazione VERIFICATA di un frame. Frame «bad» (mediaTime assente/doppione/fuori posto) → fino a `tries` nuovi seek,
 * ciascuno dopo uno spostamento del player (nudge) e con il punto di seek corretto dal mediaTime ottenuto (steer); poi, se il
 * budget lo consente, il <video> è RICREATO (reopen) e si rifà il giro. Ancora bad: onBad 'fail' → errore FramesUnverified
 * (il frame NON va all'encoder); 'mark' → consegnato e segnato (isUnverified); 'return' → restituito bad (decide il chiamante).
 * stats: + recovered (frame recuperati), recoverMs (tempo speso a recuperare), reopenBad, unverified, unvSamples [[i, ts, mt]].
 */
function verifiedGrab({ get, set = () => {}, p = 0, reopen = null, onReopen = () => {}, stats = null, tries = MAX_BAD_TRIES, budget = null, onBad = 'fail', alive = () => true }) {
  const raw = reopenGrab(get, set, p, reopen, onReopen, stats);
  budget ||= { reopens: 0, max: MAX_BAD_REOPEN };
  return async (f, signal, idx) => {
    if (!stats) return raw(f, signal);
    const prev = stats.prevMT; // doppione = uguale all'ultimo frame CONSEGNATO da questo player, non all'ultimo tentativo
    const r0 = await raw(f, signal);
    if (!r0.bad) return r0;
    const t0 = performance.now(); let best = r0, last = r0, k = 0, reopened = 0;
    const keep = (x) => { last = x; if (score(f, x) < score(f, best)) { best.vf.close(); best = x; } else x.vf.close(); };
    const cycle = async () => {
      for (let j = 1; j <= tries && best.bad && alive() && !signal?.aborted; j++) {
        k++; stats.retried++;
        // v0.35: un nuovo seek allo STESSO istante non presenta nulla (rVFC muta): prima ci si sposta. L'ultimo spostamento è
        // lontano (~0.5 s): il decoder riparte dal keyframe invece di proseguire dallo stato che ha dato il frame sbagliato.
        await nudge(get(), f, signal, j === tries && tries > 1);
        stats.prevMT = prev;
        keep(await raw(f, signal, steer(f, last.mt, j)));
      }
    };
    try {
      await cycle();
      if (best.bad && reopen && onBad !== 'return' && budget.reopens < budget.max && alive() && !signal?.aborted) {
        budget.reopens++; reopened++; stats.reopenBad = (stats.reopenBad || 0) + 1;
        onReopen(p, new Error(`frame ${idx ?? '?'} non verificato dopo ${k + 1} seek (${desc(f, last.mt)})`), budget.reopens);
        set(await reopen(p)); stats.prevMT = prev; k++;
        keep(await raw(f, signal));
        await cycle();
      }
    } catch (e) { try { best.vf.close(); } catch {} throw e; }
    stats.recoverMs = (stats.recoverMs || 0) + performance.now() - t0;
    if (!best.bad) { stats.recovered = (stats.recovered || 0) + 1; stats.prevMT = best.mt; return best; }
    stats.prevMT = prev;
    if (onBad === 'return') return best;
    stats.unverified = (stats.unverified || 0) + 1;
    if ((stats.unvSamples ||= []).length < 5) stats.unvSamples.push([idx ?? null, +(f.ts / 1e6).toFixed(4), best.mt == null ? null : +best.mt.toFixed(4)]);
    if (onBad === 'fail') {
      best.vf.close();
      throw framesUnverifiedError(`frame ${idx ?? '?'} (${(f.ts / 1e6).toFixed(3)} s) non verificabile dopo ${k + 1} seek${reopened ? ' e la ricreazione del player' : ''} (${desc(f, best.mt)}): voce interrotta invece di scrivere un file con frame ripetuti o fuori ordine`);
    }
    unverified.add(best.vf); // prevMT resta quello dell'ultimo frame verificato (il mediaTime sbagliato non deve far sembrare doppione il successivo)
    return best;
  };
}

/**
 * Estrazione parallela: due <video> distinti sullo stesso File; il player 0 prende gli indici pari, il 1 i dispari, in parallelo.
 * I frame tornano in ordine di presentazione (buffer: al massimo `maxFlight` frame vivi in totale, incluso quello in mano al
 * chiamante). Ogni player usa la stessa procedura verificata di seekFrames. Se un player dà errore o un frame fallisce la verifica
 * (mediaTime assente/doppione/fuori posto) si passa AUTOMATICAMENTE a 1 solo player (videos[0]) per il resto: il frame sospetto viene
 * scartato e riestratto in sequenza. Ogni frame non consegnato è chiuso. `stats`: {n,dup,off,noCallback,retried,samples (globali),
 * players:[stats per player], fellBack, fallbackReason}. Con 1 solo video equivale a seekFrames.
 */
export async function* parallelFrames(videos, frames, stats, signal = null, { maxFlight = 4, onFallback = () => {}, reopen = null, onReopen = () => {}, budget = null, onBad = 'fail', reopenBad = true, base = 0 } = {}) {
  frames = withSpan(frames);
  videos = [...videos]; // v0.36.2: un player ricreato (reopen) sostituisce il suo elemento solo qui dentro
  const P = videos.length, N = frames.length;
  stats.players = videos.map(() => newStats()); stats.fellBack = false; stats.fallbackReason = '';
  stats.n = 0; stats.dup = 0; stats.off = 0; stats.noCallback = 0; stats.retried = 0; stats.samples = []; stats.unvSamples = [];
  const buf = new Map(); // indice → {vf, bad, mt}
  let next = 0, degraded = false, stop = false, waiters = [], prevMT = null;
  const notify = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };
  const wake = () => new Promise((r) => waiters.push(r));
  const onAbort = () => notify(); signal?.addEventListener('abort', onAbort);
  const degrade = (why) => { if (degraded) return; degraded = true; stats.fellBack = true; stats.fallbackReason = why; onFallback(why); notify(); };
  const failures = [], broken = new Set(); // broken: player andati in errore (v0.36.2: il fallback continua con un player SANO)
  const worker = async (p) => {
    // v0.22.1/v0.35: frame bad → nuovi seek (dopo uno spostamento) prima di arrendersi; ancora bad → 1 player (il sequenziale lo riprova)
    const wg = verifiedGrab({ get: () => videos[p], p, stats: stats.players[p], alive: () => !stop && !degraded, onBad: 'return' });
    try {
      for (let i = p; i < N; i += P) {
        while (!stop && !degraded && !signal?.aborted && i >= next + maxFlight) await wake(); // finestra: max frame vivi
        if (stop || degraded || signal?.aborted) return;
        const r = await wg(frames[i], signal, base + i); // v0.36.3: stessi nuovi seek guidati del sequenziale (senza ricreare il player)
        if (stop || degraded) { r.vf.close(); return; }
        if (r.bad) { r.vf.close(); degrade(`player ${p + 1}: frame ${base + i} non verificato dopo ${MAX_BAD_TRIES + 1} seek (${desc(frames[i], r.mt)})`); return; }
        buf.set(i, r); notify();
      }
    } catch (e) {
      if (signal?.aborted || e?.name === 'BackgroundInterrupt') { failures.push(e); notify(); return; }
      broken.add(p); degrade(`player ${p + 1}: ${e?.message || e}`);
      // v0.36.2: player bloccato → ricreato subito (per le estrazioni successive del chiamante); il resto di QUESTA estrazione
      // continua con un player sano. Errore nel ricrearlo: resta guasto (il sequenziale non lo usa se ce n'è un altro).
      if (isSeekTimeout(e) && reopen && !signal?.aborted) { try { onReopen(p, e, 0); videos[p] = await reopen(p); } catch (x) { if (x?.name === 'BackgroundInterrupt') failures.push(x); } }
    }
  };
  const workers = P > 1 ? videos.map((_, p) => worker(p)) : [];
  const sum = () => { for (const k of ['n', 'off', 'noCallback', 'retried', 'recovered', 'recoverMs', 'reopenBad', 'unverified']) stats[k] = stats.players.reduce((a, q) => a + (q[k] || 0), 0); stats.samples = stats.players.flatMap((q) => q.samples).slice(0, 5); stats.unvSamples = stats.players.flatMap((q) => q.unvSamples || []).slice(0, 5); };
  try {
    while (next < N) {
      if (signal?.aborted) throw interruptError();
      let r = buf.get(next);
      if (!r && !degraded && P > 1) { await wake(); continue; }
      if (r) buf.delete(next);
      else { // un solo player (scelta o fallback): attende gli altri worker, scarta i frame in anticipo, poi estrae in sequenza da `next`
        await Promise.all(workers);
        if (signal?.aborted || failures.length) throw failures[0] || interruptError();
        for (const x of buf.values()) x.vf.close(); buf.clear();
        // v0.36.2: un player sano (prima: sempre il player 1, anche quando era proprio lui ad essersi bloccato)
        const sp = P > 1 && broken.has(0) && !broken.has(1) ? 1 : 0, ps = stats.players[sp]; ps.prevMT = null; stats.soloPlayer = sp + 1;
        const grab = verifiedGrab({ get: () => videos[sp], set: (v) => { videos[sp] = v; }, p: sp, reopen, onReopen, stats: ps, budget: reopenBad ? budget : { reopens: 0, max: 0 }, onBad });
        for (; next < N; next++) {
          let g; try { g = await grab(frames[next], signal, base + next); } finally { sum(); }
          if (prevMT != null && g.mt != null && Math.abs(g.mt - prevMT) < 1e-4) stats.dup++;
          if (g.mt != null) prevMT = g.mt;
          sum(); notify();
          yield g.vf;
        }
        break;
      }
      if (prevMT != null && r.mt != null && Math.abs(r.mt - prevMT) < 1e-4) stats.dup++; // doppione globale tra frame consecutivi in uscita
      if (r.mt != null) prevMT = r.mt;
      sum();
      try { yield r.vf; } finally { next++; notify(); }
    }
  } finally {
    stop = true; notify(); signal?.removeEventListener('abort', onAbort);
    await Promise.allSettled(workers);
    for (const x of buf.values()) { try { x.vf.close(); } catch {} } buf.clear();
  }
}

/** Rilascia la sorgente (decoder/player di WebKit): pausa, via src (+ load) e Blob URL revocato. L'elemento resta riusabile. */
export function releaseVideoElement(v) {
  if (!v) return;
  try { v.pause(); } catch {}
  const u = v.getAttribute?.('src');
  if (u) { try { URL.revokeObjectURL(u); } catch {} v.removeAttribute('src'); try { v.load(); } catch {} }
  try { if (v.isConnected) v.remove(); } catch {}
}
