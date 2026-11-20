// Suono di fine lavoro + notifica (v0.24).
// iOS: l'AudioContext va creato/sbloccato in un gesto utente (tap su Comprimi) → unlock(); a fine job done()/fail().
// Notifiche: su iOS solo per la web app installata (Home) con permesso; nella tab Safari non esistono → fallback: suono +
// titolo Media Session ("Compressione completata").

let ctx = null;

// v0.25.2: in PiP fuori da Safari iOS trattiene il Web Audio (suona solo al rientro). Si prova con un <audio> (riproduzione
// "media", ammessa in background): WAV del jingle generato in pagina, elemento sbloccato nel tap (play muto → pause).
let el = null;
function wavOf(notes, sr = 22050) {
  const parts = []; let total = 0;
  for (const [f, d] of notes) { const n = Math.floor(sr * d * 0.9); parts.push([f, n, Math.floor(sr * d)]); total += n; }
  total += Math.floor(sr * 0.25);
  const data = new Int16Array(total); let o = 0;
  for (const [f, n, nd] of parts) {
    for (let i = 0; i < nd && o + i < total; i++) {
      const env = Math.min(1, i / 200) * Math.exp(-3 * i / nd);
      const sq = (Math.floor(2 * f * (o + i) / sr) % 2) ? 1 : -1;
      data[o + i] += Math.round(sq * env * 6000);
    }
    o += n;
  }
  const buf = new ArrayBuffer(44 + data.length * 2), dv = new DataView(buf);
  const w = (p, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(p + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, data.length * 2, true);
  new Int16Array(buf, 44).set(data);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
const DONE_NOTES = [[523, 0.09], [659, 0.09], [784, 0.09], [1047, 0.22]], FAIL_NOTES = [[392, 0.16], [262, 0.3]];
let urlDone = null, urlFail = null;
function unlockElement() {
  try {
    urlDone = urlDone || wavOf(DONE_NOTES); urlFail = urlFail || wavOf(FAIL_NOTES);
    el = el || Object.assign(document.createElement('audio'), { preload: 'auto' });
    el.setAttribute('playsinline', ''); el.src = urlDone; el.muted = true;
    const p = el.play(); if (p) p.then(() => { el.pause(); el.currentTime = 0; el.muted = false; }).catch(() => { el.muted = false; });
  } catch {}
}
function playElement(url) {
  if (!el) return false;
  try { el.muted = false; if (el.src !== url) el.src = url; el.currentTime = 0; const p = el.play(); p?.catch?.(() => {}); return true; } catch { return false; }
}

/** Da chiamare SINCRONO nel tap di Comprimi. */
export function unlock() {
  unlockElement();
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    // buffer muto di 1 campione: sblocca la riproduzione su iOS
    const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
  } catch { ctx = null; }
}

function play(notes) {
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume();
    let t = ctx.currentTime + 0.05;
    for (const [freq, dur] of notes) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = freq; // timbro 8-bit
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02); t += dur * 0.9;
    }
  } catch {}
}

const isStandalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } };

/** Nel tap di Comprimi: chiede il permesso notifiche solo se ha senso (web app installata, API presente, non ancora deciso). */
export function askNotify() {
  try { if (isStandalone() && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch {}
}

function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'fcv-job' };
      if (navigator.serviceWorker?.controller) navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts)).catch(() => { try { new Notification(title, opts); } catch {} });
      else new Notification(title, opts);
      return true;
    }
  } catch {}
  return false;
}

function mediaTitle(t) { try { if (navigator.mediaSession) navigator.mediaSession.metadata = new MediaMetadata({ title: t, artist: 'Finally Compress' }); } catch {} }

/** Fine riuscita: jingle ascendente + notifica (se possibile) + titolo Media Session. */
export function done({ sound = true, savedPct = null, fileName = '' } = {}) {
  const body = `${savedPct != null ? `−${Math.round(savedPct)}% · ` : ''}${fileName}`.trim();
  if (sound && !playElement(urlDone)) play(DONE_NOTES); // <audio> (ammesso in background) con fallback Web Audio
  mediaTitle(`Compressione completata${savedPct != null ? ` −${Math.round(savedPct)}%` : ''}`);
  return notify('Compressione completata ✓', body || 'Il video è pronto da salvare nelle Foto.');
}

/** Errore/interruzione: due note discendenti + notifica. */
export function fail(message = '') {
  if (!playElement(urlFail)) play(FAIL_NOTES);
  mediaTitle('Compressione interrotta');
  return notify('Compressione interrotta', message || 'Apri l\'app per riprendere.');
}
