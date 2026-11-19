// EXPERIMENT (opt-in, advanced settings): keep the WebContent process alive in background with audio playback
// (research/13 §2: WebKit keeps a page alive while it plays audio). Must be started synchronously inside the user's tap.
// Two sources: an <audio loop> with a near-silent WAV (makes Now Playing / Media Session appear) + a Web Audio
// oscillator at very low gain. Nothing here is required for the export; every failure is only logged.

/** 1 s mono 16-bit WAV, ±2 LSB dither (not digital zero, which might be optimised away). */
function quietWav(sr = 22050) {
  const n = sr, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  let seed = 1; for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; v.setInt16(44 + i * 2, (seed % 5) - 2, true); }
  return new Blob([b], { type: 'audio/wav' });
}

export function startKeepAlive({ log = () => {}, title = 'Compressione in corso' } = {}) {
  const st = { ctx: null, osc: null, audio: null, url: null, stopped: false, pauses: 0 };
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { log('keep-alive: audioSession non impostabile: ' + e.message); }
  // <audio> first: play() must be called synchronously in the gesture.
  try {
    st.url = URL.createObjectURL(quietWav());
    const a = st.audio = new Audio(st.url); a.loop = true; a.volume = 1; a.setAttribute('playsinline', '');
    a.play().then(() => log('keep-alive: <audio> in riproduzione (loop WAV quasi muto)'), (e) => log('keep-alive: <audio>.play() rifiutato: ' + (e?.name || '') + ' ' + (e?.message || '')));
    a.addEventListener('pause', () => { if (!st.stopped) { st.pauses++; log(`keep-alive: <audio> in pausa (${document.visibilityState})`); } });
    a.addEventListener('play', () => { if (!st.stopped && st.pauses) log('keep-alive: <audio> ripreso'); });
  } catch (e) { log('keep-alive: <audio> non disponibile: ' + e.message); }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = st.ctx = new AC(); const osc = st.osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = 30; g.gain.value = 0.0001; // ~ -80 dBFS a 30 Hz: inudibile
    osc.connect(g).connect(ctx.destination); osc.start();
    ctx.resume().catch(() => {});
    ctx.onstatechange = () => { if (!st.stopped) log(`keep-alive: AudioContext ${ctx.state} (${document.visibilityState})`); };
  } catch (e) { log('keep-alive: Web Audio non disponibile: ' + e.message); }
  const ms = navigator.mediaSession;
  const resume = () => { try { st.audio?.play().catch(() => {}); st.ctx?.resume().catch(() => {}); } catch {} };
  try {
    if (ms && window.MediaMetadata) {
      ms.metadata = new MediaMetadata({ title, artist: 'Finally Compress', album: 'Esportazione video' });
      ms.setActionHandler?.('play', () => { log('keep-alive: Now Playing → play'); resume(); });
      ms.setActionHandler?.('pause', () => { log('keep-alive: Now Playing → pausa ignorata (riprendo)'); resume(); });
      ms.playbackState = 'playing';
    } else log('keep-alive: Media Session non disponibile');
  } catch (e) { log('keep-alive: Media Session: ' + e.message); }
  let lastTitle = '';
  return {
    get pauses() { return st.pauses; },
    state: () => `audio ${st.audio ? (st.audio.paused ? 'pausa' : 'play') : '—'}, ctx ${st.ctx?.state || '—'}`,
    setTitle(t) { if (t === lastTitle || st.stopped) return; lastTitle = t; try { if (ms && window.MediaMetadata) ms.metadata = new MediaMetadata({ title: t, artist: 'Finally Compress', album: 'Esportazione video' }); } catch {} },
    /** Called when the page becomes visible again: restart audio if iOS paused it. */
    nudge: resume,
    stop() {
      if (st.stopped) return; st.stopped = true;
      try { st.audio?.pause(); st.audio?.removeAttribute('src'); st.audio?.load(); } catch {}
      try { if (st.url) URL.revokeObjectURL(st.url); } catch {}
      try { st.osc?.stop(); st.ctx?.close(); } catch {}
      try { if (ms) { ms.metadata = null; ms.playbackState = 'none'; for (const a of ['play', 'pause']) ms.setActionHandler?.(a, null); } } catch {}
    },
  };
}
