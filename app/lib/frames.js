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

/**
 * Yields VideoFrames for the given source timestamps (microseconds, from the demuxer).
 * Seeks to the centre of each frame so VFR (17/33 ms) frames are hit exactly once.
 * Caller MUST close() every frame.
 */
export async function* seekFrames(video, frames /* [{ts, dur}] in µs, presentation order */, stats = null, signal = null) {
  // stats (optional): verify via rVFC which frame was actually presented after each seek.
  let prevMT = null;
  for (const f of frames) {
    const target = (f.ts + f.dur / 2) / 1e6;
    const pr = stats ? new Promise((res) => { const t = setTimeout(() => res(null), 250); video.requestVideoFrameCallback((_, md) => { clearTimeout(t); res(md.mediaTime); }); }) : null;
    if (signal?.aborted) throw interruptError();
    video.currentTime = target;
    let ev = await waitEvent(video, 'seeked', SEEK_TIMEOUT_MS, signal);
    if (ev === 'abort') throw interruptError(); // background: esce subito, senza aspettare il timeout
    if (ev === 'timeout') { // guasto reale (pagina visibile): un solo nuovo tentativo
      video.currentTime = target + 1e-6; ev = await waitEvent(video, 'seeked', SEEK_TIMEOUT_MS, signal);
      if (ev === 'abort') throw interruptError();
      if (ev === 'timeout') throw new Error(`seek timeout @${target.toFixed(3)}s`);
      if (stats) stats.retried = (stats.retried || 0) + 1;
    }
    if (stats) {
      const mt = await pr; stats.n++;
      if (mt == null) stats.noCallback++;
      else {
        if (prevMT != null && Math.abs(mt - prevMT) < 1e-4) stats.dup++;
        if (mt < f.ts / 1e6 - 2e-3 || mt > (f.ts + f.dur) / 1e6 + 2e-3) { stats.off++; if (stats.samples.length < 5) stats.samples.push([+(f.ts / 1e6).toFixed(4), +mt.toFixed(4)]); }
        prevMT = mt;
      }
    }
    yield new VideoFrame(video, { timestamp: f.ts, duration: f.dur });
  }
}

export function releaseVideoElement(v) {
  try { URL.revokeObjectURL(v.src); } catch {}
  v.removeAttribute('src'); v.load();
}
