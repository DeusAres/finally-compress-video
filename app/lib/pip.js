// Picture-in-Picture come "tenere viva la pagina" (research/13, SVOLTA): con un <video> SEPARATO in riproduzione muta in PiP,
// iOS non segnala il background (visibilityState resta "visible") e decoder/encoder/seek continuano a piena velocità.
// Solo tab Safari (PWA standalone: bug WebKit 303885). Nessun audio. L'elemento è distinto da quello usato per i seek.
//
// v0.21.1: iOS rifiuta la PiP se il video non ha ancora dati (readyState 0) o è praticamente invisibile: il video viene quindi
// PREPARATO all'avvio dell'export (prepare(): anteprima piccola ma visibile, muta, in loop, già in riproduzione) e al tap
// start() chiama solo requestPictureInPicture (fallback webkitSetPresentationMode), come nella pagina di test che funziona.

// v0.36.2: per la CODA la PiP resta UN solo <video> per tutta la sessione e la sua sorgente è una CLIP LEGGERA generata in
// pagina (H.264 288×512, 10 fps, 2 s in loop, ~50 KB) invece del file sorgente: prima l'anteprima riproduceva in loop il
// video della prima voce (1080p/4K) per tutta la coda, cioè un decoder hardware sempre occupato accanto ai 2 player di seek e
// all'encoder (research/16 §3). prepare() parte dal file (dati subito, come prima) e passa alla clip appena è pronta, solo se
// la PiP non è ancora aperta (cambiare sorgente a PiP aperta potrebbe chiuderla); se la clip non si riproduce torna al file.
let clipBlob = null, clipP = null;
async function makeClip(MB, { w = 288, h = 512, fps = 10, sec = 2 } = {}) {
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = cv.getContext('2d', { alpha: false }); if (!g) throw new Error('canvas 2D non disponibile');
  const N = fps * sec, draw = (i) => {
    g.fillStyle = '#14110d'; g.fillRect(0, 0, w, h);
    for (let k = 0; k < 12; k++) { // rotella: 12 punti, quello «attivo» gira in 2 s (loop senza scatti)
      const a = (k / 12) * 2 * Math.PI - Math.PI / 2, on = ((k - Math.round(i * 12 / N)) % 12 + 12) % 12;
      g.globalAlpha = 1 - on / 13; g.fillStyle = '#f3ecdc';
      g.beginPath(); g.arc(w / 2 + Math.cos(a) * w * 0.22, h * 0.42 + Math.sin(a) * w * 0.22, w * 0.035, 0, 2 * Math.PI); g.fill();
    }
    g.globalAlpha = 1; g.fillStyle = '#f3ecdc'; g.textAlign = 'center'; g.font = `bold ${Math.round(w * 0.085)}px sans-serif`;
    g.fillText('Compressione', w / 2, h * 0.70); g.fillText('in corso', w / 2, h * 0.70 + w * 0.11);
  };
  const target = new MB.BufferTarget(), out = new MB.Output({ format: new MB.Mp4OutputFormat(), target });
  let done = false;
  try {
    const src = new MB.CanvasSource(cv, { codec: 'avc', bitrate: 200_000 });
    out.addVideoTrack(src, { frameRate: fps });
    await out.start();
    for (let i = 0; i < N; i++) { draw(i); await src.add(i / fps, 1 / fps); }
    await out.finalize(); done = true;
  } finally { if (!done) { try { await out.cancel(); } catch {} } } // encoder interno di Mediabunny mai lasciato aperto
  return new Blob([target.buffer], { type: 'video/mp4' });
}
/** Clip leggera per l'anteprima PiP (generata una volta per pagina; null se non ancora pronta). */
export const pipClipReady = () => clipBlob;
export function pipClip(MB) {
  if (clipBlob) return Promise.resolve(clipBlob);
  return clipP ||= makeClip(MB).then((b) => (clipBlob = b), (e) => { clipP = null; throw e; });
}

export const pipSupported = () => {
  const p = HTMLVideoElement.prototype;
  return !!((document.pictureInPictureEnabled && p.requestPictureInPicture) || p.webkitSetPresentationMode);
};

/**
 * prepare() all'avvio dell'export; start() SINCRONO nel tap (nessun await prima della richiesta PiP).
 * @returns {{prepare(): void, start(): Promise<boolean>, stop(): Promise<void>, active: boolean, elapsedS(): number}}
 */
export function createPip(file, { log = () => {}, onChange = () => {}, clip = null } = {}) {
  let v = null, url = null, active = false, t0 = 0, total = 0, stopped = false, kind = '';
  // stessa <video>, sorgente cambiata (mai un secondo elemento): il vecchio Blob URL è revocato dopo il cambio
  const setSource = (blob, k) => {
    const old = url; url = URL.createObjectURL(blob); kind = k; v.src = url;
    if (old) { try { URL.revokeObjectURL(old); } catch {} }
    v.play().catch((e) => log(`anteprima PiP: play rifiutato (${e?.name || e})`));
  };
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
    document.body.appendChild(v);
    const ready = clip ? pipClipReady() : null;
    setSource(ready || file, ready ? 'clip' : 'file');
    v.addEventListener('error', () => { if (v && kind === 'clip' && !stopped) { log(`anteprima PiP: clip leggera non riproducibile (errore ${v.error?.code ?? '?'}): uso il video`); setSource(file, 'file'); } });
    if (clip && !ready) clip().then((b) => {
      if (!v || stopped || kind === 'clip') return;
      if (active) { log('anteprima PiP: clip leggera pronta ma PiP già aperta: resta il video sorgente'); return; }
      setSource(b, 'clip');
    }, (e) => log(`anteprima PiP: clip leggera non generata (${e?.name || ''} ${e?.message || e}): uso il video`));
    v.addEventListener('enterpictureinpicture', opened);
    v.addEventListener('leavepictureinpicture', closed);
    v.addEventListener('webkitpresentationmodechanged', () => { if (v?.webkitPresentationMode === 'picture-in-picture') opened(); else closed(); });
  };
  return {
    get active() { return active; },
    /** 'clip' (clip leggera) | 'file' (video sorgente) | '' (non preparata) */
    get source() { return v ? kind : ''; },
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
