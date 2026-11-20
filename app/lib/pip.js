// Picture-in-Picture come "tenere viva la pagina" (research/13, SVOLTA): con un <video> SEPARATO in riproduzione muta in PiP,
// iOS non segnala il background (visibilityState resta "visible") e decoder/encoder/seek continuano a piena velocità.
// Solo tab Safari (PWA standalone: bug WebKit 303885). Nessun audio. L'elemento è distinto da quello usato per i seek.

export const pipSupported = () => !!(document.pictureInPictureEnabled && HTMLVideoElement.prototype.requestPictureInPicture);

/**
 * start() va chiamato SINCRONO nel tap (nessun await prima di requestPictureInPicture).
 * @returns {{start(): Promise<boolean>, stop(): Promise<void>, active: boolean, elapsedS(): number}}
 */
export function createPip(file, { log = () => {}, onChange = () => {} } = {}) {
  let v = null, url = null, active = false, t0 = 0, total = 0, stopped = false;
  const cleanup = () => {
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch {} v = null; }
    if (url) { try { URL.revokeObjectURL(url); } catch {} url = null; }
  };
  const closed = () => {
    if (!active) return;
    active = false; total += performance.now() - t0; onChange(false);
    log(`PiP chiusa (${document.visibilityState}, in PiP ${(total / 1000).toFixed(1)} s)`);
    if (!stopped) cleanup();
  };
  return {
    get active() { return active; },
    elapsedS: () => (total + (active ? performance.now() - t0 : 0)) / 1000,
    async start() {
      if (active || stopped) return active;
      try {
        if (!pipSupported()) throw new Error('Picture-in-Picture non disponibile');
        cleanup();
        v = document.createElement('video');
        v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
        v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
        v.style.cssText = 'position:fixed;width:2px;height:2px;opacity:.01;pointer-events:none;left:0;top:0';
        url = URL.createObjectURL(file); v.src = url; document.body.appendChild(v);
        v.addEventListener('leavepictureinpicture', closed);
        const p = v.play(); // nello stesso tick del gesto
        const r = v.requestPictureInPicture();
        await Promise.all([p, r]);
        active = true; t0 = performance.now(); onChange(true);
        log('PiP attivata: la pagina resta attiva anche uscendo da Safari finché la finestrella è aperta');
        return true;
      } catch (e) {
        log(`PiP non avviata: ${e?.name || ''} ${e?.message || e}`);
        cleanup(); return false;
      }
    },
    async stop() {
      stopped = true;
      const was = active;
      try { if (document.pictureInPictureElement === v) await document.exitPictureInPicture(); } catch {}
      if (was) closed();
      cleanup();
    },
  };
}
