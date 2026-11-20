// Suono di fine lavoro + notifica (v0.24).
// iOS: l'AudioContext va creato/sbloccato in un gesto utente (tap su Comprimi) → unlock(); a fine job done()/fail().
// Notifiche: su iOS solo per la web app installata (Home) con permesso; nella tab Safari non esistono → fallback: suono +
// titolo Media Session ("Compressione completata").

let ctx = null;

/** Da chiamare SINCRONO nel tap di Comprimi. */
export function unlock() {
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
  if (sound) play([[523, 0.09], [659, 0.09], [784, 0.09], [1047, 0.22]]);
  mediaTitle(`Compressione completata${savedPct != null ? ` −${Math.round(savedPct)}%` : ''}`);
  return notify('Compressione completata ✓', body || 'Il video è pronto da salvare nelle Foto.');
}

/** Errore/interruzione: due note discendenti + notifica. */
export function fail(message = '') {
  play([[392, 0.16], [262, 0.3]]);
  mediaTitle('Compressione interrotta');
  return notify('Compressione interrotta', message || 'Apri l\'app per riprendere.');
}
