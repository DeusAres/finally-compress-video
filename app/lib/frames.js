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

export const SEEK_TIMEOUT_MS = 4000; // solo per guasti reali: il passaggio in background interrompe via AbortSignal

export async function openVideoElement(file, signal) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.src = URL.createObjectURL(file);
  try {
    if (v.readyState < 1 && (await waitEvent(v, 'loadedmetadata', 10000, signal)) === 'abort') throw interruptError();
    // Safari needs a decoded frame before seeks deliver pictures reliably.
    try {
      await Promise.race([v.play(), new Promise((_, rej) => { if (signal?.aborted) rej(interruptError()); else signal?.addEventListener('abort', () => rej(interruptError()), { once: true }); })]);
      v.pause();
    } catch (e) { if (e?.name === 'BackgroundInterrupt') throw e; /* muted autoplay may still be refused; seeks work anyway */ }
  } catch (e) { releaseVideoElement(v); throw e; }
  return v;
}

/** Statistiche di verifica per un player (rVFC/mediaTime come vstats). */
export const newStats = () => ({ n: 0, dup: 0, off: 0, noCallback: 0, retried: 0, samples: [], prevMT: null });

/**
 * Estrae UN frame: rVFC richiesto PRIMA del seek, attesa 'seeked', controllo mediaTime (se `ps` è dato), poi new VideoFrame(video).
 * Ritorna {vf, bad}: bad = mediaTime assente/doppione/fuori posto (il frame è comunque creato; decide il chiamante).
 */
async function grabFrame(video, f, ps, signal) {
  const target = (f.ts + f.dur / 2) / 1e6;
  const pr = ps ? new Promise((res) => { const t = setTimeout(() => res(null), 250); video.requestVideoFrameCallback((_, md) => { clearTimeout(t); res(md.mediaTime); }); }) : null;
  if (signal?.aborted) throw interruptError();
  video.currentTime = target;
  let ev = await waitEvent(video, 'seeked', SEEK_TIMEOUT_MS, signal);
  if (ev === 'abort') throw interruptError(); // background: esce subito, senza aspettare il timeout
  if (ev === 'timeout') { // guasto reale (pagina visibile): un solo nuovo tentativo
    video.currentTime = target + 1e-6; ev = await waitEvent(video, 'seeked', SEEK_TIMEOUT_MS, signal);
    if (ev === 'abort') throw interruptError();
    if (ev === 'timeout') throw new Error(`seek timeout @${target.toFixed(3)}s`);
    if (ps) ps.retried++;
  }
  let bad = false, mt = null;
  if (ps) {
    mt = await pr; ps.n++;
    if (mt == null) { ps.noCallback++; bad = true; }
    else {
      if (ps.prevMT != null && Math.abs(mt - ps.prevMT) < 1e-4) { ps.dup++; bad = true; }
      if (mt < f.ts / 1e6 - 2e-3 || mt > (f.ts + f.dur) / 1e6 + 2e-3) { ps.off++; bad = true; if (ps.samples.length < 5) ps.samples.push([+(f.ts / 1e6).toFixed(4), +mt.toFixed(4)]); }
      ps.prevMT = mt;
    }
  }
  return { vf: new VideoFrame(video, { timestamp: f.ts, duration: f.dur }), bad, mt };
}

/**
 * Yields VideoFrames for the given source timestamps (microseconds, from the demuxer).
 * Seeks to the centre of each frame so VFR (17/33 ms) frames are hit exactly once.
 * Caller MUST close() every frame.
 */
export async function* seekFrames(video, frames /* [{ts, dur}] in µs, presentation order */, stats = null, signal = null) {
  // stats (optional): verify via rVFC which frame was actually presented after each seek.
  if (stats) { stats.retried ||= 0; stats.prevMT ??= null; }
  for (const f of frames) yield (await grabFrame(video, f, stats, signal)).vf;
}

/**
 * Estrazione parallela: due <video> distinti sullo stesso File; il player 0 prende gli indici pari, il 1 i dispari, in parallelo.
 * I frame tornano in ordine di presentazione (buffer: al massimo `maxFlight` frame vivi in totale, incluso quello in mano al
 * chiamante). Ogni player usa la stessa procedura verificata di seekFrames. Se un player dà errore o un frame fallisce la verifica
 * (mediaTime assente/doppione/fuori posto) si passa AUTOMATICAMENTE a 1 solo player (videos[0]) per il resto: il frame sospetto viene
 * scartato e riestratto in sequenza. Ogni frame non consegnato è chiuso. `stats`: {n,dup,off,noCallback,retried,samples (globali),
 * players:[stats per player], fellBack, fallbackReason}. Con 1 solo video equivale a seekFrames.
 */
export async function* parallelFrames(videos, frames, stats, signal = null, { maxFlight = 4, onFallback = () => {} } = {}) {
  const P = videos.length, N = frames.length;
  stats.players = videos.map(() => newStats()); stats.fellBack = false; stats.fallbackReason = '';
  stats.n = 0; stats.dup = 0; stats.off = 0; stats.noCallback = 0; stats.retried = 0; stats.samples = [];
  const buf = new Map(); // indice → {vf, bad, mt}
  let next = 0, degraded = false, stop = false, waiters = [], prevMT = null;
  const notify = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };
  const wake = () => new Promise((r) => waiters.push(r));
  const onAbort = () => notify(); signal?.addEventListener('abort', onAbort);
  const degrade = (why) => { if (degraded) return; degraded = true; stats.fellBack = true; stats.fallbackReason = why; onFallback(why); notify(); };
  const failures = [];
  const worker = async (p) => {
    try {
      for (let i = p; i < N; i += P) {
        while (!stop && !degraded && !signal?.aborted && i >= next + maxFlight) await wake(); // finestra: max frame vivi
        if (stop || degraded || signal?.aborted) return;
        let r = await grabFrame(videos[p], frames[i], stats.players[p], signal);
        // v0.22.1: su iPhone il 2° player può non confermare i primi frame (riscaldamento): ritenta lo stesso frame
        // fino a 3 volte prima di arrendersi (prima: fallback immediato al primo mediaTime assente).
        for (let k = 0; r.bad && k < 3 && !stop && !degraded && !signal?.aborted; k++) {
          r.vf.close(); stats.players[p].retried++;
          r = await grabFrame(videos[p], frames[i], stats.players[p], signal);
        }
        if (stop || degraded) { r.vf.close(); return; }
        if (r.bad) { r.vf.close(); degrade(`player ${p + 1}: frame ${i} non verificato dopo 3 tentativi (mediaTime ${r.mt == null ? 'assente' : r.mt.toFixed(4)})`); return; }
        buf.set(i, r); notify();
      }
    } catch (e) {
      if (signal?.aborted || e?.name === 'BackgroundInterrupt') { failures.push(e); notify(); return; }
      degrade(`player ${p + 1}: ${e?.message || e}`);
    }
  };
  const workers = P > 1 ? videos.map((_, p) => worker(p)) : [];
  const sum = () => { for (const k of ['n', 'off', 'noCallback', 'retried']) stats[k] = stats.players.reduce((a, q) => a + q[k], 0); stats.samples = stats.players.flatMap((q) => q.samples).slice(0, 5); };
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
        const ps = stats.players[0]; ps.prevMT = null;
        for (; next < N; next++) {
          const g = await grabFrame(videos[0], frames[next], ps, signal);
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

export function releaseVideoElement(v) {
  try { URL.revokeObjectURL(v.src); } catch {}
  v.removeAttribute('src'); v.load();
}
