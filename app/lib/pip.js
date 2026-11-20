// Picture-in-Picture come "tenere viva la pagina" (research/13, SVOLTA): con un <video> SEPARATO in riproduzione muta in PiP,
// iOS non segnala il background (visibilityState resta "visible") e decoder/encoder/seek continuano a piena velocità.
// Solo tab Safari (PWA standalone: bug WebKit 303885). Nessun audio. L'elemento è distinto da quello usato per i seek.
//
// v0.21.1: iOS rifiuta la PiP se il video non ha ancora dati (readyState 0) o è praticamente invisibile: il video viene quindi
// PREPARATO all'avvio dell'export (prepare(): anteprima piccola ma visibile, muta, in loop, già in riproduzione) e al tap
// start() chiama solo requestPictureInPicture (fallback webkitSetPresentationMode), come nella pagina di test che funziona.

export const pipSupported = () => {
  const p = HTMLVideoElement.prototype;
  return !!((document.pictureInPictureEnabled && p.requestPictureInPicture) || p.webkitSetPresentationMode);
};

/**
 * prepare() all'avvio dell'export; start() SINCRONO nel tap (nessun await prima della richiesta PiP).
 * @returns {{prepare(): void, start(): Promise<boolean>, stop(): Promise<void>, active: boolean, elapsedS(): number}}
 */
export function createPip(file, { log = () => {}, onChange = () => {} } = {}) {
  let v = null, url = null, active = false, t0 = 0, total = 0, stopped = false;
  const cleanup = () => {
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch {} v = null; }
    if (url) { try { URL.revokeObjectURL(url); } catch {} url = null; }
  };
  const opened = () => { if (active) return; active = true; t0 = performance.now(); onChange(true); log('PiP attivata: la pagina resta attiva anche uscendo da Safari finché la finestrella è aperta'); };
  const closed = () => {
    if (!active) return;
    active = false; total += performance.now() - t0; onChange(false);
    log(`PiP chiusa (${document.visibilityState}, in PiP ${(total / 1000).toFixed(1)} s)`);
  };
  const prepare = () => {
    if (v || stopped) return;
    v = document.createElement('video');
    v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true; v.preload = 'auto'; v.autoplay = true;
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('autoplay', '');
    v.title = 'Anteprima (Picture-in-Picture)';
    // piccola anteprima VISIBILE in basso a destra (iOS non mette in PiP un video invisibile/minuscolo)
    v.style.cssText = 'position:fixed;right:max(10px,env(safe-area-inset-right,0px));bottom:max(10px,env(safe-area-inset-bottom,0px));width:72px;height:128px;object-fit:cover;z-index:50;border:3px solid currentColor;background:#000;pointer-events:none';
    url = URL.createObjectURL(file); v.src = url; document.body.appendChild(v);
    v.addEventListener('enterpictureinpicture', opened);
    v.addEventListener('leavepictureinpicture', closed);
    v.addEventListener('webkitpresentationmodechanged', () => { if (v?.webkitPresentationMode === 'picture-in-picture') opened(); else closed(); });
    v.play().catch((e) => log(`anteprima PiP: play rifiutato (${e?.name || e})`));
  };
  return {
    get active() { return active; },
    elapsedS: () => (total + (active ? performance.now() - t0 : 0)) / 1000,
    prepare,
    async start() {
      if (active || stopped) return active;
      if (!v) prepare(); // fallback: se non preparato, almeno ci prova (può fallire se non ha ancora dati)
      try {
        if (v.paused) v.play().catch(() => {});
        if (v.requestPictureInPicture && document.pictureInPictureEnabled) {
          try { await v.requestPictureInPicture(); opened(); return true; }
          catch (e) { log(`PiP standard rifiutata (${e?.name || ''} ${e?.message || e}, readyState ${v.readyState}): provo webkitSetPresentationMode`); }
        }
        if (v.webkitSetPresentationMode) { v.webkitSetPresentationMode('picture-in-picture'); return true; } // opened() arriva dall'evento
        throw new Error('Picture-in-Picture non disponibile');
      } catch (e) {
        log(`PiP non avviata: ${e?.name || ''} ${e?.message || e} (readyState ${v?.readyState})`);
        return false;
      }
    },
    async stop() {
      stopped = true;
      const was = active;
      // v0.23: chiudi DAVVERO la finestrella prima di rimuovere il video (su iOS il confronto pictureInPictureElement === v
      // può fallire e rimuovere il video in PiP lasciava la finestrella aperta): prova entrambe le API e attendi l'uscita.
      if (v) {
        const left = new Promise((r) => { const t = setTimeout(r, 1500); const done = () => { clearTimeout(t); r(); };
          v.addEventListener('leavepictureinpicture', done, { once: true });
          v.addEventListener('webkitpresentationmodechanged', () => { if (v?.webkitPresentationMode !== 'picture-in-picture') done(); }); });
        let asked = false;
        try { if (document.pictureInPictureElement) { await document.exitPictureInPicture(); asked = true; } } catch {}
        try { if (v.webkitPresentationMode === 'picture-in-picture') { v.webkitSetPresentationMode('inline'); asked = true; } } catch {}
        if (asked || active) await left;
        try { v.pause(); } catch {}
      }
      if (was) closed();
      cleanup();
    },
  };
}
