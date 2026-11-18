// Frame-exact 10-bit frame source for Safari iOS.
// Validated on device (research/02 §10, run 9): seek + 'seeked' + new VideoFrame(video)
// yields native HLG frames (format null), distinct, ~5 ms per seek.
// VideoDecoder would downconvert to NV12 8-bit; GPU canvas would give BGRA 8-bit.

const waitEvent = (el, ev, ms) => new Promise((res) => {
  const t = setTimeout(() => res('timeout'), ms);
  el.addEventListener(ev, () => { clearTimeout(t); res(ev); }, { once: true });
});

export async function openVideoElement(file) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.src = URL.createObjectURL(file);
  if (v.readyState < 1) await waitEvent(v, 'loadedmetadata', 10000);
  // Safari needs a decoded frame before seeks deliver pictures reliably.
  try { await v.play(); v.pause(); } catch { /* muted autoplay may still be refused; seeks work anyway */ }
  return v;
}

/**
 * Yields VideoFrames for the given source timestamps (microseconds, from the demuxer).
 * Seeks to the centre of each frame so VFR (17/33 ms) frames are hit exactly once.
 * Caller MUST close() every frame.
 */
export async function* seekFrames(video, frames /* [{ts, dur}] in µs, presentation order */, stats = null) {
  // stats (optional): verify via rVFC which frame was actually presented after each seek.
  let prevMT = null;
  for (const f of frames) {
    const target = (f.ts + f.dur / 2) / 1e6;
    const pr = stats ? new Promise((res) => { const t = setTimeout(() => res(null), 250); video.requestVideoFrameCallback((_, md) => { clearTimeout(t); res(md.mediaTime); }); }) : null;
    video.currentTime = target;
    const ev = await waitEvent(video, 'seeked', 3000);
    if (ev === 'timeout') throw new Error(`seek timeout @${target.toFixed(3)}s`);
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
