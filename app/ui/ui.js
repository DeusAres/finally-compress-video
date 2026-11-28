// UI pixel art di finally-compress-video. Contratto: app/ui/README.md.
// mountUI(root, handlers) → { setBusy, setDefaults, getSettings, setSaveMessage, reset } (+ coda v0.36: setQueueMode, setQueue, …)
import { bus } from './bus.js?v=0.39.1';
import { sprite, SPRITES } from './sprite.js?v=0.39.1';
import { makeThumb } from './../lib/thumb.js?v=0.39.1';
import { createLogStore } from './logstore.js?v=0.39.1';
import { worthRecompress, SCENE } from './../lib/scenesearch.js?v=0.39.1';
import { estimateOutBytes, SCENE_TIME_FACTOR, estimateTimeS, saveSpeed } from './estimate.js?v=0.39.1';

const BITRATES = [4, 6, 8, 10, 12, 14];
const KEYFRAMES = [1, 4, 10];
const BR_INFO = {
  4: { q: 2, t: 'Molto leggero: solo per chat.' },
  6: { q: 3, t: 'Leggero: bene sul telefono, scene mosse un po\' meno.' },
  8: { q: 4, t: 'Consigliato: quasi identico (VMAF ~89).' },
  10: { q: 4, t: 'Più margine per scene difficili.' },
  12: { q: 5, t: 'Qualità alta, risparmio moderato.' },
  14: { q: 5, t: 'Quasi trasparente: per originali molto dettagliati.' },
};
const KF_INFO = {
  1: 'Scorrimento precisissimo, file un po\' più pesante.',
  4: 'Equilibrio consigliato tra peso e scorrimento.',
  10: 'File un filo più leggero, scorrimento meno preciso.',
};
const RES_LIST = [2160, 1440, 1080, 720, 540, 480]; // formati standard (lato corto); solo quelli sotto la sorgente, mai ingrandimenti
const resLbl = (v) => (v === 'orig' ? 'Originale' : v === 2160 ? '4K' : `${v}p`);
const MODE_INFO = {
  hdr: '<b>HDR 10 bit</b> · Dolby Vision · più lento',
  hdr8: '<b>HDR 8 bit</b> · niente Dolby Vision · ~2,5× più veloce',
  sdr: '<b>SDR 8 bit</b> · compatibile ovunque · più veloce',
};
const AUDIO = [
  { v: 'copy', b: 'Originale', t: 'Copia l\'audio com\'è: nessuna perdita, istantaneo. Consigliato.' },
  { v: 'v4', b: 'Ripara eco v4', t: 'Per eco o rimbombo digitale (es. dopo un Comando Rapido). Analizza tutto il file.' },
  { v: 'v3', b: 'Ripara eco v3', t: 'Versione precedente (confronti tecnici): adattiva, canali L+R.', dev: true },
  { v: 'v2', b: 'Ripara eco v2', t: 'Versione precedente (confronti tecnici): filtro per frequenza.', dev: true },
  { v: 'v1', b: 'Ripara eco v1', t: 'Prima versione (confronti tecnici), la più semplice.', dev: true },
  { v: 'reenc', b: 'Ricodifica', t: 'Diagnostica: ricodifica AAC senza filtri.', dev: true },
];
const KEEP_OPEN = 'Tieni l\'app aperta e lo schermo acceso.';
const AUDIO_SHORT = { copy: 'audio originale', v4: 'eco v4', v3: 'eco v3', v2: 'eco v2', v1: 'eco v1', reenc: 'audio ricodificato' };
const PHASES = [
  { id: 'analisi', label: 'Analisi', sub: 'Leggo tracce, colori e Dolby Vision' },
  { id: 'video', label: 'Video', sub: 'HEVC a segmenti riprendibili' },
  { id: 'assemblaggio', label: 'Unione', sub: 'Unisco i segmenti video', icon: 'film' },
  { id: 'audio', label: 'Audio', sub: 'Preparo la traccia audio' },
  { id: 'scrittura', label: 'File', sub: 'File e metadati' },
];
const WEIGHT = { analisi: 0.04, video: 0.82, assemblaggio: 0.04, audio: 0.07, scrittura: 0.03 };
const parN = (s) => (s.par2 ? (s.par3 ? 3 : 2) : 0); // player di estrazione per la stima del tempo (0 = 1 player)
const DEFAULTS = { mode: 'hdr', bitrateMbps: 8, keyframeS: 4, audioMode: 'copy', bgAudio: false, par2: true, par3: false, sceneQ: true, apac: true, container: 'mov' }; // par3 (v0.37, sperimentale): 3 player invece di 2 // container: 'mov' (QuickTime, come gli originali iPhone, v0.34) | 'mp4' // apac: audio spaziale + metadati iPhone (mebx) mantenuti (v0.32/v0.33, solo se la sorgente li ha) // par2 ON da v0.24 (verificato su iPhone, anche con PiP; fallback automatico)

const nf1 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
const fmtMB = (x) => (x >= 100 ? nf0 : nf1).format(x);
const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) return '—';
  s = Math.round(s);
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const resLabel = (w, h) => { const m = Math.min(w || 0, h || 0); return m >= 2160 ? '4K' : m >= 1440 ? '1440p' : m >= 1080 ? '1080p' : m >= 720 ? '720p' : m ? `${m}p` : ''; };

function ensureStyles() {
  for (const name of ['theme.css', 'ui.css']) {
    // v0.36.1: confronto senza query (index.html li carica con ?v= per non ricevere CSS vecchi dalla cache di Safari)
    const href = new URL(name, import.meta.url).href, bare = (u) => { try { const x = new URL(u, location.href); return x.origin + x.pathname; } catch { return u; } };
    if (![...document.styleSheets].some((s) => s.href && bare(s.href) === bare(href)) && ![...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => bare(l.href) === bare(href))) {
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
    }
  }
}

function template(opts) {
  const s = (k, o) => sprite(SPRITES[k], o);
  const chev = s('chevron', { scale: 2, className: 'chev' });
  const brSeg = BITRATES.map((b) => `<label><input type="radio" name="fcv-br" value="${b}"${b === 8 ? ' aria-label="8 Mbps, consigliato"' : ''}><span>${b === 8 ? `<i class="star">${s('star', { scale: 2 })}</i>` : ''}${b}<small>Mbps</small></span></label>`).join('');
  const kfSeg = KEYFRAMES.map((k) => `<label><input type="radio" name="fcv-kf" value="${k}"><span>${k}<small>sec</small></span></label>`).join('');
  const audio = AUDIO.map((a) => `<label class="fcv-radio"${a.dev ? ' data-dev' : ''}><input type="radio" name="fcv-audio" value="${a.v}" data-desc="${esc(a.t)}"><div><b>${a.b}</b></div></label>`).join('');
  const chain = PHASES.map((p) => `<li data-p="${p.id}" title="${p.label}">${s(p.icon || p.id, { scale: 2 })}<span>${p.label}</span></li>`).join('');
  // opzione (casella) con titolo breve, sottotitolo e spiegazione lunga dietro il tasto «i»
  const opt = (name, b, sub, desc, extra = '') => `<label class="fcv-radio fcv-opt"><input type="checkbox" name="${name}" value="1"${extra}><div><b>${b}</b>${sub ? `<i>${sub}</i>` : ''}<span class="fcv-d" hidden>${desc}</span></div><button type="button" class="fcv-i" aria-expanded="false" aria-label="Dettagli: ${esc(b)}">i</button></label>`;
  const ver = (String(opts.version || '').match(/v?\d[\w.]*/) || [''])[0];
  return `
<header class="fcv-head">
  ${s('logo', { scale: 3, className: 'fcv-logo px-bob', title: 'Logo' })}
  <h1 class="px-title">Finally <b>Compress</b> Video<span class="fcv-cursor px-blink"></span></h1>
  ${ver ? `<button type="button" class="px-chip px-chip--num fcv-ver" data-ref="verBtn" aria-haspopup="dialog" aria-label="Informazioni sull'app, versione ${esc(ver)}">${esc(ver)}</button>` : `<button type="button" class="px-chip fcv-ver" data-ref="verBtn" aria-haspopup="dialog">Info</button>`}
  <button type="button" class="px-chip fcv-safari" data-ref="safariBtn" hidden title="Apri in Safari: lì funziona la Picture-in-Picture" aria-label="Apri in Safari (nella scheda di Safari funziona la Picture-in-Picture)">${s('compass', { scale: 2 })}</button>
</header>
<p class="fcv-open-msg" data-ref="safariMsg" role="status" aria-live="polite"></p>

<div class="fcv-drop" data-ref="drop" hidden aria-hidden="true">${s('film', { scale: 8, className: 'px-bob' })}<b class="px-title">Rilascia qui i video</b><span>Più video = una coda</span></div>

<section class="px-panel fcv-card fcv-step-file" aria-labelledby="fcv-h1">
  <h2 class="px-sr" id="fcv-h1">Scegli il video</h2>
  <label class="fcv-pick" data-ref="pick">
    <input type="file" accept="video/*,.mov,.mp4" multiple data-ref="input" aria-label="Scegli uno o più video">
    ${s('film', { scale: 5, className: 'px-bob' })}
    <span class="fcv-pick-cta">Tocca per scegliere</span>
    <small>Uno o più video · restano sul telefono</small>
  </label>
  <details class="fcv-note fcv-pick-note" data-ref="pickNote">
    <summary>${chev}<span>Meglio «Scegli file» che «Libreria foto»</span></summary>
    <div class="fcv-dbody"><p class="fcv-subtle">Da «Scegli file» (app File) il video arriva intatto; da «Libreria foto» iOS può consegnare una copia ricodificata. Nessun caricamento: il video non lascia l'iPhone.</p></div>
  </details>
  <p class="fcv-drop-msg" data-ref="dropMsg" role="status" aria-live="polite" hidden></p>
</section>

<section class="px-panel fcv-card fcv-queue" data-ref="queue" hidden aria-labelledby="fcv-hq">
  <header><h2 class="px-title" id="fcv-hq">Coda di video</h2><span class="px-chip px-chip--num fcv-q-count" data-ref="qCount">0</span></header>
  <p class="fcv-q-msg" data-ref="qMsg" role="status" aria-live="polite" hidden></p>
  <p class="fcv-q-tot" data-ref="qTot" aria-live="polite"></p>
  <ol class="fcv-q-list" data-ref="qList" aria-label="Video in coda"></ol>
  <div class="fcv-q-actions">
    <label class="px-btn px-btn--primary fcv-relabel fcv-sm" data-ref="qRelinkBox" hidden><span data-ref="qRelinkTxt">Riseleziona i video</span><input type="file" accept="video/*,.mov,.mp4" multiple data-ref="qRelink" aria-label="Riseleziona i video della coda"></label>
    <label class="px-btn fcv-relabel fcv-sm">Aggiungi video<input type="file" accept="video/*,.mov,.mp4" multiple data-ref="qAdd" aria-label="Aggiungi video alla coda"></label>
    <button class="px-btn fcv-sm" type="button" data-ref="qClear">Svuota coda</button>
  </div>
  <details class="fcv-note">
    <summary>${chev}<span>Come funziona la coda</span></summary>
    <div class="fcv-dbody"><p class="fcv-subtle">I video si comprimono uno alla volta, nell'ordine in cui li hai aggiunti; quelli aggiunti mentre lavora vanno in fondo. Le impostazioni valgono per tutta la coda.</p></div>
  </details>
</section>

<section class="px-panel fcv-card fcv-step-set" aria-labelledby="fcv-h2">
  <h2 class="px-sr" id="fcv-h2">Regola la qualità</h2>
  <fieldset class="fcv-field">
    <legend class="px-sr">Bitrate video</legend>
    <div class="px-seg fcv-seg-br" data-ref="br">${brSeg}</div>
    <div class="fcv-rowh"><p class="fcv-hint" data-ref="brHint" aria-live="polite"></p><div class="fcv-hearts" data-ref="hearts"></div></div>
  </fieldset>
  <div class="fcv-mode">
    <div class="fcv-sws">
      <label class="fcv-switch" title="HDR o SDR">
        <input type="checkbox" name="fcv-mode" role="switch" value="hdr" checked aria-label="Modo HDR (spento: SDR)">
        <span class="trk" aria-hidden="true"><span class="lb l">HDR</span><span class="lb r">SDR</span>
          <span class="knob"><i class="sun">${s('sun', { scale: 2 })}</i><i class="moon">${s('moon', { scale: 2 })}</i><b class="t-hdr">HDR</b><b class="t-sdr">SDR</b></span></span>
      </label>
      <div class="fcv-sw-bits">
        <label class="fcv-switch fcv-bits" title="10 bit o 8 bit">
          <input type="checkbox" name="fcv-bits" role="switch" value="10" checked aria-label="10 bit (spento: 8 bit)">
          <span class="trk" aria-hidden="true"><span class="lb l">10 BIT</span><span class="lb r">8 BIT</span>
            <span class="knob"><b class="t-hdr">10 BIT</b><b class="t-sdr">8 BIT</b></span></span>
        </label>
      </div>
    </div>
    <p class="fcv-mode-d" data-ref="modeDesc" aria-live="polite"></p>
  </div>
  <fieldset class="fcv-field fcv-res" data-ref="resBox" hidden>
    <legend class="px-sr">Risoluzione</legend>
    <div class="fcv-resgrid" data-ref="resGrid"></div>
  </fieldset>
  <details class="fcv-est">
    <summary aria-label="Previsione di peso e tempo; tocca per i dettagli">
      <div class="fcv-tiles" aria-live="polite">
        <div class="fcv-tile"><span class="px-label">Peso</span><span class="tv" data-ref="est">—</span></div>
        <div class="fcv-tile"><span class="px-label">Tempo</span><span class="tv" data-ref="estT">—</span></div>
      </div>${chev}
    </summary>
    <div class="fcv-dbody"><p class="fcv-subtle" data-ref="estSrc" hidden></p></div>
  </details>
  <p class="fcv-warn" data-ref="warn" hidden></p>
  <details class="fcv-adv">
    <summary>${chev}<span class="fcv-sum-txt"><b>Opzioni avanzate</b><span class="fcv-adv-sum" data-ref="advSum"></span></span></summary>
    <div class="fcv-dbody">
      <fieldset class="fcv-field">
        <legend class="px-label">Fotogramma chiave ogni</legend>
        <div class="px-seg" data-ref="kf">${kfSeg}</div>
        <p class="fcv-hint" data-ref="kfHint"></p>
      </fieldset>
      <fieldset class="fcv-field">
        <legend class="px-label">Audio</legend>
        <div class="fcv-radios fcv-radios--2" data-ref="audio">${audio}</div>
        <p class="fcv-hint" data-ref="audioHint"></p>
      </fieldset>
      <fieldset class="fcv-field" data-ref="apacBox" hidden>
        <legend class="px-label">Tracce iPhone</legend>
        ${opt('fcv-apac', 'Mantieni audio spaziale e metadati', 'solo video iPhone', 'Copia invariate la traccia audio spaziale e le tracce di metadati dell\'iPhone (orientamento, volti, Live Photo, luminosità della scena, «cinematic-audio»), come nell\'originale: in Foto restano l\'audio spaziale e «Mix audio». L\'audio spaziale (e la sua traccia «cinematic-audio») solo con l\'audio «copia»: con la riparazione dell\'eco o la ricodifica viene tolto, i metadati video restano. Audio spaziale ~0,4 Mbps, metadati trascurabili.', ' checked')}
      </fieldset>
      <fieldset class="fcv-field">
        <legend class="px-label">Contenitore</legend>
        <div class="fcv-radios fcv-radios--2">
          <label class="fcv-radio"><input type="radio" name="fcv-container" value="mov" checked data-desc="File QuickTime .mov come gli originali iPhone: Foto riconosce audio spaziale e metadati."><div><b>MOV</b><i>come iPhone</i></div></label>
          <label class="fcv-radio"><input type="radio" name="fcv-container" value="mp4" data-desc="File .mp4 (come fino alla v0.33), per programmi che non leggono il MOV."><div><b>MP4</b></div></label>
        </div>
        <p class="fcv-hint" data-ref="contHint"></p>
      </fieldset>
      <fieldset class="fcv-field">
        <legend class="px-label">Sperimentale</legend>
        ${opt('fcv-sceneq', 'Qualità garantita per scena', '~1,6× più lento', 'Prova più bitrate per ogni tratto e sceglie il minimo che resta «quasi perfetto» (VMAF stimato ≥ 88); più lento. Il bitrate scelto sopra diventa il limite massimo: il file non pesa mai più della stima.')}
        ${opt('fcv-bgaudio', 'Test background con audio', 'su iOS 27 non tiene la decodifica', 'Riproduce un audio quasi muto per provare a far continuare la compressione con l\'app in background (controlli «In riproduzione»). Il log registra un battito al secondo e un riepilogo finale.')}
        ${opt('fcv-par2', 'Estrazione parallela', '~1,7× più veloce', 'Se un player sbaglia passa a 1 per pochi frame, poi torna al parallelo da solo.')}
        <div class="fcv-radios fcv-radios--2" role="radiogroup" aria-label="Player di estrazione">
          <label class="fcv-radio"><input type="radio" name="fcv-npar" value="2"><div><b>2 player</b></div></label>
          <label class="fcv-radio"><input type="radio" name="fcv-npar" value="3"><div><b>3 player</b><i>sperimentale</i></div></label>
        </div>
      </fieldset>
    </div>
  </details>
</section>

<section class="fcv-step-go" aria-labelledby="fcv-h3">
  <h2 class="px-sr" id="fcv-h3">Comprimi</h2>
  <button class="px-btn px-btn--primary px-btn--xl px-btn--block fcv-go" data-ref="go" disabled>Comprimi ${sprite(['c...', 'cc..', 'ccc.', 'cccc', 'ccc.', 'cc..', 'c...'], { scale: 3 })}</button>
  <p class="fcv-go-note" data-ref="goNote">Scegli prima un video.</p>
  <div class="fcv-resume" data-ref="resume" hidden>
    <p class="fcv-warn" data-ref="resumeText"></p>
    <button class="px-btn px-btn--ok px-btn--block" data-ref="resumeBtn">Riprendi export</button>
  </div>
</section>

<section class="px-panel fcv-prog" data-ref="prog" hidden aria-labelledby="fcv-hp">
  <p class="fcv-q-now" data-ref="qNow" hidden></p>
  <div class="fcv-summary" data-ref="summary"></div>
  <div class="fcv-prog-top">
    <div class="fcv-phase"><span data-ref="phIcon">${s('analisi', { scale: 3 })}</span><div><b id="fcv-hp" data-ref="phName">Analisi</b><span data-ref="phSub"></span></div></div>
    <div class="fcv-pct px-digits" data-ref="pct" aria-hidden="true">0<small>%</small></div>
  </div>
  <div class="px-bar" role="progressbar" aria-label="Avanzamento" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-ref="bar"><i></i></div>
  <ol class="fcv-chain" data-ref="chain">${chain}</ol>
  <div class="fcv-grid">
    <div class="fcv-stat"><span class="px-label">Restante</span><span class="v px-digits" data-ref="eta">—</span></div>
    <div class="fcv-stat"><span class="px-label">Trascorso</span><span class="v px-digits" data-ref="elapsed">0:00</span></div>
    <div class="fcv-stat"><span class="px-label">Velocità</span><span class="v px-digits" data-ref="fps">—</span></div>
    <div class="fcv-stat"><span class="px-label">Fotogrammi</span><span class="v px-digits" data-ref="frames">—</span></div>
  </div>
  <p class="fcv-tline" data-ref="tline" hidden></p>
  <p class="fcv-keep" data-ref="progNote" role="status" aria-live="polite">${KEEP_OPEN}</p>
  <div class="fcv-pip" data-ref="pipBox" hidden>
    <button class="px-btn px-btn--block" data-ref="pipBtn" type="button">Continua in Picture-in-Picture</button>
    <p class="fcv-pip-note" data-ref="pipNote" hidden></p>
  </div>
  <div class="fcv-cancels"><button class="px-btn px-btn--danger fcv-cancel" data-ref="cancel" title="Annulla questo video: lo salta e la coda prosegue.">Annulla</button><button class="px-btn fcv-cancel" data-ref="qStop" type="button" hidden title="Ferma coda: si ferma qui e il video in corso riprenderà dai segmenti già pronti." aria-label="Ferma coda: si ferma qui e il video in corso riprenderà dai segmenti già pronti.">Ferma coda</button></div>
  <p class="px-sr" aria-live="polite" data-ref="live"></p>
</section>

<section class="px-panel fcv-done" data-ref="done" hidden aria-labelledby="fcv-hd">
  <div class="fcv-confetti" data-ref="confetti" aria-hidden="true"></div>
  <div class="fcv-done-title">${s('star', { scale: 3 })}<h2 class="px-title" id="fcv-hd" data-ref="doneTitle">Fatto!</h2>${s('star', { scale: 3 })}</div>
  <div>
    <div class="fcv-big px-digits" data-ref="big">−0%</div>
    <div class="fcv-big-sub" data-ref="bigSub">più leggero</div>
  </div>
  <div class="fcv-cmp">
    <div class="fcv-cmp-row"><span class="px-label">Prima</span><div class="px-bar before" style="--p:1"><i></i></div><span class="v" data-ref="inMB"></span></div>
    <div class="fcv-cmp-row"><span class="px-label">Dopo</span><div class="px-bar" data-ref="afterBar"><i></i></div><span class="v" data-ref="outMB"></span></div>
  </div>
  <p class="fcv-freed" data-ref="freed"></p>
  <p class="fcv-scene-br" data-ref="sceneBr" hidden></p>
  <details class="fcv-note fcv-pred" data-ref="pred" hidden>
    <summary>${chev}<span>Previsto e reale: <span data-ref="predSum"></span></span></summary>
    <div class="fcv-dbody"><table class="fcv-tbl fcv-pred-tbl"><thead><tr><th></th><th scope="col">Previsto</th><th scope="col">Reale</th><th scope="col">Scarto</th></tr></thead><tbody>
      <tr><th scope="row">Peso <small>MB</small></th><td data-ref="pW1"></td><td data-ref="pW2"></td><td data-ref="pW3"></td></tr>
      <tr><th scope="row">Tempo <small>m:ss</small></th><td data-ref="pT1"></td><td data-ref="pT2"></td><td data-ref="pT3"></td></tr>
    </tbody></table>
    <p class="fcv-pred-note" data-ref="predNote" hidden></p></div>
  </details>
  <button class="px-btn px-btn--ok px-btn--xl px-btn--block" data-ref="save">${s('scrittura', { scale: 3 })}Salva nelle Foto</button>
  <p class="fcv-save-msg" data-ref="saveMsg" aria-live="polite"></p>
  <p class="fcv-outname" data-ref="outName"></p>
  <div class="fcv-done-more">
    <button class="px-btn fcv-sm" data-ref="again">Altre impostazioni</button>
    <label class="px-btn fcv-relabel fcv-sm">Nuovo video<input type="file" accept="video/*,.mov,.mp4" multiple data-ref="input3" aria-label="Scegli un nuovo video"></label>
  </div>
</section>

<section class="px-panel fcv-done fcv-qdone" data-ref="qdone" hidden aria-labelledby="fcv-hqd">
  <div class="fcv-confetti" data-ref="qConfetti" aria-hidden="true"></div>
  <div class="fcv-done-title">${s('star', { scale: 3 })}<h2 class="px-title" id="fcv-hqd" data-ref="qdTitle">Coda finita!</h2>${s('star', { scale: 3 })}</div>
  <div>
    <div class="fcv-big px-digits" data-ref="qdBig">−0%</div>
    <div class="fcv-big-sub" data-ref="qdSub"></div>
  </div>
  <div class="fcv-qd-one" data-ref="qdOne" hidden></div>
  <div class="fcv-dscroll" data-ref="qdScroll"><table class="fcv-tbl fcv-qd-tbl"><caption class="fcv-subtle" data-ref="qdCap"></caption><thead><tr><th scope="col">Video</th><th scope="col">Dopo <small>MB</small></th><th scope="col">%</th><th scope="col">Tempo</th></tr></thead><tbody data-ref="qdBody"></tbody><tfoot data-ref="qdFoot"></tfoot></table></div>
  <p class="fcv-pred-note" data-ref="qdNote" hidden></p>
  <button class="px-btn px-btn--ok px-btn--xl px-btn--block" data-ref="qSaveAll">${s('scrittura', { scale: 3 })}<span data-ref="qSaveAllTxt">Salva tutti nelle Foto</span></button>
  <p class="fcv-save-msg" data-ref="qdMsg" aria-live="polite"></p>
  <div class="fcv-qd-files" data-ref="qdFiles" hidden></div>
  <div class="fcv-done-more">
    <label class="px-btn fcv-relabel fcv-sm">Aggiungi<input type="file" accept="video/*,.mov,.mp4" multiple data-ref="qAdd2" aria-label="Aggiungi video alla coda"></label>
    <button class="px-btn fcv-sm" type="button" data-ref="qRedo" title="Riprova con impostazioni diverse">Rifai</button>
    <button class="px-btn fcv-sm" type="button" data-ref="qNew">Svuota</button>
  </div>
</section>

<section class="px-panel fcv-err" data-ref="err" hidden role="alert">
  <header>${s('errore', { scale: 3 })}<h2 class="px-title">Si è inceppato!</h2></header>
  <p class="fcv-err-msg" data-ref="errMsg"></p>
  <details class="fcv-note">
    <summary>${chev}<span>Cosa provare</span></summary>
    <div class="fcv-dbody"><ul>
      <li>Tieni Safari in primo piano e lo schermo acceso durante la compressione.</li>
      <li>Chiudi le altre app pesanti e riprova; per video molto lunghi prova un bitrate più basso.</li>
      <li>Se si ripete, copia il log tecnico e mandalo.</li>
    </ul></div>
  </details>
  <div class="fcv-row">
    <button class="px-btn px-btn--primary" data-ref="retry">Riprova</button>
    <button class="px-btn" data-ref="errCopy">Copia log</button>
  </div>
</section>

<div class="fcv-tools">
<details class="px-panel fcv-log" data-ref="logBox">
  <summary>${chev}<b>Log tecnico</b><span class="px-chip count" data-ref="logCount">0</span></summary>
  <div class="fcv-dbody">
    <div class="fcv-log-view"><span data-ref="logView" aria-live="off"></span><button class="px-btn fcv-sm fcv-log-all" data-ref="logAll" type="button">Mostra tutto</button></div>
    <pre data-ref="log" tabindex="0"></pre>
    <textarea class="fcv-log-sel" data-ref="logSel" readonly hidden aria-label="Riassunto del log da copiare"></textarea>
    <div class="fcv-log-actions"><button class="px-btn fcv-sm" data-ref="copy">Copia log</button><button class="px-btn fcv-sm" data-ref="saveLog">Salva .txt completo</button><span class="fcv-copy-msg" data-ref="copyMsg" aria-live="polite"></span></div>
  </div>
</details>

<details class="px-panel fcv-log fcv-store" data-ref="stBox">
  <summary>${chev}<b>Spazio</b><span class="px-chip count" data-ref="stCount">–</span></summary>
  <div class="fcv-dbody">
    <p class="fcv-st-line" data-ref="stLine">Apri per calcolare lo spazio usato dall'app.</p>
    <div class="fcv-st-actions"><button class="px-btn px-btn--primary fcv-sm" data-ref="stFree" type="button" disabled>Libera spazio</button><span class="fcv-copy-msg" data-ref="stMsg" aria-live="polite"></span></div>
    <details class="fcv-st-det" data-ref="stDet">
      <summary>${chev}<b>Dettagli</b></summary>
      <p class="fcv-st-est" data-ref="stEst"></p>
      <div data-ref="stBody"></div>
      <div class="fcv-st-actions"><button class="px-btn fcv-sm" data-ref="stAll" type="button" disabled>Svuota tutto</button></div>
      <p class="fcv-st-est">Non incluse qui: le copie temporanee che Safari fa dei video scelti o trascinati (e dei file condivisi) restano fuori dal sito, in «Documenti e dati» di Safari, e la pagina non le vede né le cancella. Safari le elimina quando chiudi questa scheda (dal codice di WebKit, non verificato su iPhone); se restano (Safari chiuso a forza o riavviato), Impostazioni › Generali › Spazio iPhone › Safari mostra «Documenti e dati». Dopo una coda grande chiudi la scheda e riaprila.</p>
    </details>
  </div>
</details>
</div>

<dialog class="fcv-about" data-ref="about" aria-labelledby="fcv-ab-t">
  <div class="fcv-about-in">
    <header>${s('logo', { scale: 3, className: 'px-bob' })}<h2 class="px-title" id="fcv-ab-t">Finally Compress Video</h2></header>
    <dl class="fcv-ab-dl">
      <div><dt>Versione</dt><dd data-ref="abVer">—</dd></div>
      <div><dt>Build</dt><dd data-ref="abBuild">—</dd></div>
    </dl>
    <a class="px-btn fcv-ab-gh" href="https://github.com/DeusAres/finally-compress-video" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>DeusAres/finally-compress-video</a>
    <ul class="fcv-ab-list">
      <li><b>Tutto sul telefono.</b> Il video non viene mai caricato. Restano nel sito solo i segmenti di lavoro e i risultati non ancora salvati: si liberano da «Spazio».</li>
      <li><b>Serve</b> Safari su iPhone con iOS 27 o successivo (HEVC 10-bit, WebCodecs).</li>
      <li><b>Picture-in-Picture</b> solo nella scheda di Safari, non nell'app installata.</li>
      <li>HEVC 10-bit · HDR · Dolby Vision · nessun upload.</li>
    </ul>
    <div class="fcv-ab-go"><button type="button" class="px-btn fcv-sm" data-ref="abLog">Log tecnico</button><button type="button" class="px-btn fcv-sm" data-ref="abStore">Spazio occupato</button></div>
    <button type="button" class="px-btn px-btn--primary px-btn--block" data-ref="abClose" autofocus>Chiudi</button>
  </div>
</dialog>`;
}

/**
 * Monta la UI in `root`.
 * @param {HTMLElement} root
 * @param {{onStorageOpen?():void,onStorageAct?(act:'free'|'all'|'del',id?:string):void,onFile?(f:File):void,onStart?(s:object):void,onCancel?():void,onSave?():void,onCopyLog?():void}} handlers
 * @param {{version?:string}} [opts]  estensione: etichetta versione nella testata
 */
export function mountUI(root, handlers = {}, opts = {}) {
  ensureStyles();
  root.classList.add('fcv');
  root.innerHTML = template(opts);
  const $ = (r) => root.querySelector(`[data-ref="${r}"]`);
  const R = new Proxy({}, { get: (c, k) => (c[k] ??= $(k)) });

  const st = {
    stage: 'pick', busy: false, file: null, settings: { ...DEFAULTS },
    phase: null, overall: 0, lastPct: -1, logLines: 0, result: null, cancelling: false, t0: 0, rafPending: null,
  };

  // ---------- stato generale ----------
  function setStage(stage) {
    st.stage = stage;
    root.dataset.stage = stage;
    R.prog.hidden = stage !== 'busy';
    R.done.hidden = stage !== 'done' || st.qMode;
    R.qdone.hidden = stage !== 'done' || !st.qMode;
    R.err.hidden = stage !== 'error';
    syncGo();
  }
  // Pulsante «Comprimi»: singolo video o coda («Comprimi N video»: voci in attesa con il loro file).
  function syncGo() {
    root.dataset.picked = st.file || st.qMode ? '1' : '0';
    if (!st.qMode) {
      R.go.disabled = !st.file || st.busy;
      R.go.firstChild.textContent = 'Comprimi ';
      R.goNote.textContent = st.file ? 'Tieni Safari aperto e lo schermo acceso.' : 'Scegli prima un video.';
      return;
    }
    const items = st.queue?.items || [], n = items.filter((it) => it.status === 'attesa' && it.hasFile).length, miss = items.filter(needsFile).length;
    R.go.disabled = st.busy || !n;
    R.go.firstChild.textContent = n ? `Comprimi ${n} video ` : 'Comprimi ';
    R.goNote.textContent = n ? `Uno alla volta. Tieni Safari aperto e lo schermo acceso.${miss ? ` ${miss} da riselezionare: saltati.` : ''}`
      : miss ? 'Riseleziona i video della coda per continuare.' : 'Nessun video in attesa: aggiungine alla coda.';
  }
  function setBusy(b) {
    st.busy = !!b; if (!b) { st.pipOn = false; setTimeout(() => thumbPump(), 0); } updatePip();
    root.dataset.busy = String(st.busy);
    root.querySelectorAll('.fcv-step-set input, [data-ref^="input"]').forEach((i) => { i.disabled = st.busy; });
    syncGo(); syncStorage();
    if (st.busy) {
      R.resume.hidden = true;
      if (st.stage !== 'busy') startProgress();
    } else if (st.stage === 'busy') {
      // finito senza 'result' né 'error' → annullato (coda: fermata o interrotta → torna alla lista)
      setStage(st.file || st.qMode ? 'ready' : 'pick');
      R.resume.hidden = !st.resume;
      if (st.cancelling) R.goNote.textContent = 'Compressione annullata.';
    }
    st.cancelling = false;
    resetCancel();
  }
  function resetCancel() {
    R.cancel.disabled = false; R.cancel.textContent = st.qMode ? 'Annulla video' : 'Annulla'; R.cancel.title = st.qMode ? 'Annulla questo video: lo salta e la coda prosegue.' : 'Annulla la compressione.';
    R.qStop.hidden = !st.qMode; R.qStop.disabled = false; R.qStop.textContent = 'Ferma coda';
  }

  // ---------- passo 1: file ----------
  function onPicked(e) {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (!files.length) return;
    takeFiles(files.filter(isVideo).length ? files.filter(isVideo) : files);
  }
  // v0.38.5: uno o più video scelti/trascinati → SEMPRE in coda (anche uno solo; si possono aggiungere altri in qualsiasi momento).
  function takeFiles(files) { R.dropMsg.hidden = true; handlers.onQueueAdd?.(files); }
  // ---------- drag & drop (pagina intera; iPad/iPhone: trascinamento da Foto in Split View / Slide Over) ----------
  const isVideo = (f) => /^video\//.test(f.type) || /\.(mov|mp4|m4v|hevc)$/i.test(f.name || '');
  const hasFiles = (e) => { const t = e.dataTransfer?.types; return !!t && [...t].includes('Files'); };
  let dragDepth = 0;
  const dropOn = (on) => { R.drop.hidden = !on; root.classList.toggle('fcv-dragging', on); };
  const dropMessage = (t) => { R.dropMsg.textContent = t; R.dropMsg.hidden = false; };
  const canDrop = () => true; // durante la coda si possono aggiungere video (vanno in fondo)
  const onDragEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (!canDrop()) return; dragDepth++; dropOn(true); };
  const onDragOver = (e) => { if (!hasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = canDrop() ? 'copy' : 'none'; } catch {} };
  const onDragLeave = (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOn(false); };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dropOn(false);
    if (!canDrop()) { dropMessage('Compressione in corso: attendi la fine prima di cambiare video.'); return; }
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) for (const it of e.dataTransfer.items || []) { const f = it.kind === 'file' ? it.getAsFile() : null; if (f) files.push(f); }
    // Lo stesso elemento può arrivare in più rappresentazioni (WebKit carica il tipo più fedele e il primo tipo «contenuto»):
    // per ogni nome base si prende il video più grande (più probabilmente l'originale). Più video diversi → coda.
    const vids = files.filter(isVideo), stem = (f) => (f.name || '').replace(/\.[^.]*$/, '').toLowerCase(), best = new Map();
    for (const f of vids) { const k = stem(f), o = best.get(k); if (!o || f.size > o.size) best.set(k, f); }
    const list = [...best.values()];
    if (!list.length) { dropMessage(files.length ? 'Questo non è un video: trascina un file video (MOV, MP4).' : 'Nessun file ricevuto: prova col pulsante «Tocca per scegliere».'); return; }
    takeFiles(list);
    if (files.length > vids.length) dropMessage(`Ignorati ${files.length - vids.length} file che non sono video.`);
  };
  const dndTargets = [['dragenter', onDragEnter], ['dragover', onDragOver], ['dragleave', onDragLeave], ['drop', onDrop]];
  for (const [t, h] of dndTargets) window.addEventListener(t, h);
  for (const k of ['input', 'input3']) R[k].addEventListener('change', onPicked);
  const pickedTo = () => (e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) takeFiles(files); };
  for (const k of ['qAdd', 'qAdd2', 'qRelink']) R[k].addEventListener('change', pickedTo());

  // ---------- passo 2: impostazioni ----------
  // Risoluzione (solo SDR, a 10 bit non si può ridurre): «Originale» + i formati standard SOTTO il lato corto della sorgente (verticale/orizzontale uguale).
  const shortSide = (f) => Math.min(f?.width || 0, f?.height || 0);
  const srcShort = () => (st.qMode ? Math.max(0, ...(st.queue?.items || []).filter((it) => it.info?.W).map((it) => Math.min(it.info.W, it.info.H))) : shortSide(st.file));
  const resSel = () => { const v = root.querySelector('input[name="fcv-res"]:checked')?.value; return v && v !== 'orig' ? +v : 'orig'; };
  const resApplies = (res, f) => (res !== 'orig' && res > 0 && res < shortSide(f) ? res : 'orig'); // risoluzione effettiva su un file
  function buildRes(want = st.wantRes ?? resSel()) {
    const sh = srcShort(), opts = ['orig', ...RES_LIST.filter((v) => !sh || (st.qMode ? v <= sh : v < sh))], // coda: tacche fino alla risoluzione massima (4K compreso), valore «al massimo» per voce; file singolo: la tacca uguale alla sorgente è «Originale», esclusa; senza sorgente: tutte
      near = (w) => (w === 'orig' ? 'orig' : RES_LIST.filter((v) => opts.includes(v)).sort((a, b) => Math.abs(a - w) - Math.abs(b - w))[0] ?? 'orig'), cur = opts.includes(want) ? want : near(want), key = opts.join();
    st.wantRes = cur; st.resOpts = opts.length;
    if (st.resKey !== key || !R.resGrid.querySelector('.fcv-resrail')) { // struttura solo se cambiano le opzioni (mai durante il trascinamento)
      st.resKey = key; const n = opts.length, pos = (k) => (n > 1 ? (k * 100) / (n - 1) : 0);
      R.resGrid.innerHTML = `<span class="fcv-reslbl px-digits" data-ref="resLbl" aria-hidden="true"></span><div class="fcv-resrail" role="slider" tabindex="0" aria-label="Risoluzione" aria-valuemin="0" aria-valuemax="${n - 1}"><div class="fcv-resbar"></div>${opts.map((v, k) => `<span class="fcv-restick" data-k="${k}" style="left:${pos(k)}%"></span><span class="fcv-restxt" data-k="${k}" style="left:${pos(k)}%">${v === 'orig' ? 'Orig' : v === 2160 ? '4K' : v}</span>`).join('')}<span class="fcv-resknob"></span></div><span class="px-sr">${opts.map((v) => `<input type="radio" name="fcv-res" value="${v}" tabindex="-1">`).join('')}</span>`;
      const rail = R.resGrid.querySelector('.fcv-resrail'); st.resList = opts;
      const idxAt = (x) => { const r = rail.getBoundingClientRect(); return n > 1 ? Math.max(0, Math.min(n - 1, Math.round(((x - r.left) / (r.width || 1)) * (n - 1)))) : 0; };
      const pick = (k) => { if (st.resList[k] === st.wantRes) return; st.wantRes = st.resList[k]; showRes(); rail.dispatchEvent(new Event('change', { bubbles: true })); };
      let drag = false;
      const move = (e) => { if (!drag) return; const r = rail.getBoundingClientRect(); // il cursore segue il dito in modo continuo, scatta alla tacca più vicina al rilascio
        const f = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))); rail.style.setProperty('--f', f * 100 + '%'); rail.dataset.drag = '1'; pick(idxAt(e.clientX)); };
      rail.addEventListener('pointerdown', (e) => { if (e.button) return; drag = true; try { rail.setPointerCapture(e.pointerId); } catch {} rail.focus({ preventScroll: true }); move(e); e.preventDefault(); });
      rail.addEventListener('pointermove', move);
      const end = (e) => { if (!drag) return; move(e); drag = false; delete rail.dataset.drag; rail.style.removeProperty('--f'); showRes(); try { rail.releasePointerCapture(e.pointerId); } catch {} };
      rail.addEventListener('pointerup', end); rail.addEventListener('pointercancel', end);
      rail.addEventListener('keydown', (e) => { const i = st.resList.indexOf(st.wantRes), d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'Home' ? -9 : e.key === 'End' ? 9 : 0; if (!d) return; e.preventDefault(); pick(Math.max(0, Math.min(st.resList.length - 1, i + d))); });
    }
    showRes();
  }
  function showRes() {
    const rail = R.resGrid.querySelector('.fcv-resrail'); if (!rail) return;
    const list = st.resList, i = Math.max(0, list.indexOf(st.wantRes)), n = list.length, v = list[i], pos = n > 1 ? (i * 100) / (n - 1) : 0;
    rail.style.setProperty('--p', pos + '%'); rail.setAttribute('aria-valuenow', i); rail.setAttribute('aria-valuetext', resLbl(v));
    rail.querySelectorAll('.fcv-restick').forEach((t, k) => t.classList.toggle('on', k <= i)); rail.querySelectorAll('.fcv-restxt').forEach((t, k) => t.classList.toggle('on', k === i));
    R.resGrid.querySelector('.fcv-reslbl').textContent = resLbl(v);
    R.resGrid.querySelectorAll('input[name="fcv-res"]').forEach((r) => { r.checked = r.value === String(v); });
  }
  const syncResBox = () => { R.resBox.hidden = st.settings.mode === 'hdr' || (st.resOpts || 0) < 2; };
  // 10 bit / 8 bit: in SDR il 10 bit non esiste (conversione GPU a 8 bit) → interruttore bloccato su 8 bit; tornando in HDR si ripristina la scelta precedente
  const syncBits = () => {
    const m = root.querySelector('input[name="fcv-mode"]'), b = root.querySelector('input[name="fcv-bits"]'); if (!m || !b) return;
    if (m.checked) { if (b.disabled) { b.disabled = false; b.checked = st.bits10 !== false; } else st.bits10 = b.checked; }
    else { if (!b.disabled) { st.bits10 = b.checked; b.disabled = true; } b.checked = false; }
  };
  function syncDs() {
    buildRes();
    R.apacBox.hidden = !(st.file?.apac || st.file?.meta); // «Mantieni audio spaziale e metadati iPhone»: solo se la sorgente ha apac o tracce mebx
    syncSettings();
  }
  function readSettings() {
    const v = (n) => root.querySelector(`input[name="${n}"]:checked`)?.value;
    const sdr = root.querySelector('input[name="fcv-mode"]')?.checked === false, mode = sdr ? 'sdr' : root.querySelector('input[name="fcv-bits"]')?.checked === false ? 'hdr8' : 'hdr', res = mode !== 'hdr' ? resSel() : 'orig'; // settings.mode = 'hdr' | 'hdr8' | 'sdr'; settings.res = 'orig' | 2160 | 1440 | 1080 | 720 | 540 | 480; downscale = alias di res 1080
    return { mode, bitrateMbps: +v('fcv-br') || DEFAULTS.bitrateMbps, keyframeS: +v('fcv-kf') || DEFAULTS.keyframeS, audioMode: v('fcv-audio') || DEFAULTS.audioMode, bgAudio: !!v('fcv-bgaudio'), par2: !!v('fcv-par2'), par3: v('fcv-npar') === '3', sceneQ: !!v('fcv-sceneq'), // v0.39: anche in SDR / HDR veloce (prove a 8 bit)
      res, downscale: res === 1080, apac: !!v('fcv-apac'), container: v('fcv-container') === 'mp4' ? 'mp4' : 'mov' };
  }
  function writeSettings(s) {
    const set = (n, val) => { const i = root.querySelector(`input[name="${n}"][value="${val}"]`); if (i) i.checked = true; };
    if (s.mode) { const c = root.querySelector('input[name="fcv-mode"]'); if (c) c.checked = s.mode !== 'sdr'; const f = root.querySelector('input[name="fcv-bits"]'); if (f) { if (s.mode === 'sdr') { st.bits10 = f.disabled ? st.bits10 : f.checked; f.disabled = true; f.checked = false; } else { f.disabled = false; f.checked = st.bits10 = s.mode !== 'hdr8'; } } }
    set('fcv-br', s.bitrateMbps); set('fcv-kf', s.keyframeS); set('fcv-audio', s.audioMode);
    if (s.bgAudio != null) { const c = root.querySelector('input[name="fcv-bgaudio"]'); if (c) c.checked = !!s.bgAudio; }
    if (s.par2 != null) { const c = root.querySelector('input[name="fcv-par2"]'); if (c) c.checked = !!s.par2; }
    set('fcv-npar', s.par3 ? 3 : 2);
    if (s.sceneQ != null) { const c = root.querySelector('input[name="fcv-sceneq"]'); if (c) c.checked = !!s.sceneQ; }
    if (s.res != null || s.downscale != null) { st.wantRes = s.res != null ? s.res : s.downscale ? 1080 : 'orig'; buildRes(st.wantRes); }
    if (s.apac != null) { const c = root.querySelector('input[name="fcv-apac"]'); if (c) c.checked = !!s.apac; }
    if (s.container) set('fcv-container', s.container);
    syncSettings();
  }
  function syncSettings() {
    syncBits();
    st.settings = readSettings();
    const { bitrateMbps: br, keyframeS: kf, audioMode: am } = st.settings;
    const info = BR_INFO[br] || BR_INFO[8];
    R.brHint.textContent = st.settings.sceneQ ? `Per scena: massimo ${br} Mbps.` : info.t;
    syncResBox();
    R.modeDesc.innerHTML = MODE_INFO[st.settings.mode] || MODE_INFO.hdr;
    for (const [n, ref] of [['fcv-audio', 'audioHint'], ['fcv-container', 'contHint']]) R[ref].textContent = root.querySelector(`input[name="${n}"]:checked`)?.dataset.desc || '';
    R.hearts.innerHTML = Array.from({ length: 5 }, (_, i) => sprite(SPRITES[i < info.q ? 'heart' : 'heartEmpty'], { scale: 3 })).join('') + `<span class="px-sr">${info.q} su 5</span>`;
    R.kfHint.textContent = KF_INFO[kf] || '';
    if (st.qMode && st.queue) renderQueue();
    R.advSum.textContent = `${st.settings.mode === 'sdr' ? 'SDR · ' : st.settings.mode === 'hdr8' ? 'HDR 8 bit · ' : ''}${kf}s · ${AUDIO_SHORT[am] || am}${st.settings.bgAudio ? ' · test bg' : ''}${st.settings.par2 ? ` · ${st.settings.par3 ? 3 : 2} player` : ''}${st.settings.sceneQ ? ' · qualità per scena' : ''}${st.settings.res !== 'orig' ? ` · ${st.settings.res}p` : ''}${st.settings.container === 'mp4' ? ' · MP4' : ' · MOV'}${st.file?.apac ? (st.settings.apac && am === 'copy' ? ' · spaziale' : ' · senza spaziale') : ''}${st.file?.meta && !st.file?.apac ? (st.settings.apac ? ' · metadati iPhone' : ' · senza metadati iPhone') : ''}`;
    updateEstimate();
  }
  const pixRatio = (s, f) => { const r = resApplies(s.res, f), sh = shortSide(f); if (r === 'orig' || !sh) return 1; const k = r / sh, w = (f.width || 0) * k, h = (f.height || 0) * k; return w && h ? Math.min(1, Math.pow((w * h) / (1920 * 1080), 0.75)) : 1; }; // v0.38: stessa regola dell'encoder (downscale.js resBitrateFactor): bitrate valido per il 1080p, scalato sotto
  const predictMB = (br = st.settings.bitrateMbps, d = st.file?.durationS) => (d ? estimateOutBytes({ durS: d, videoMbps: br, pixelRatio: pixRatio(st.settings, st.file), audioMode: st.settings.audioMode, aacBps: st.file?.aacBps, apacBps: st.settings.apac ? st.file?.apacBps : 0 }) / 1048576 : null); // formula in estimate.js
  const predictTime = () => { const f = st.file; return f?.durationS ? estimateTimeS({ durS: f.durationS, fps: f.fps, audioMode: st.settings.audioMode, par2: parN(st.settings), width: f.width, height: f.height, sceneQ: st.settings.sceneQ, downscale: resApplies(st.settings.res, f) !== 'orig', mode: st.settings.mode, res: resApplies(st.settings.res, f) }) : null; };
  function updateEstimate() {
    if (st.qMode) { updateQueueEstimate(); return; }
    const d = st.file?.durationS, src = st.file?.sizeMB;
    R.warn.hidden = true; R.estSrc.hidden = true;
    if (!d) { R.est.innerHTML = R.estT.innerHTML = st.file ? '…' : '—'; return; }
    const est = predictMB();
    const pct = src ? (1 - est / src) * 100 : null;
    const vary = st.settings.sceneQ; // qualità per scena: peso variabile (al massimo quello a bitrate fisso), tempo ≈ ×1.6
    R.est.innerHTML = `${vary ? '<small class="vary">variabile, al massimo</small>' : ''}<span class="v">${vary ? '≤' : '≈'} ${fmtMB(est)} <small>MB</small></span>` + (pct != null ? ` <span class="save ${pct <= 0 ? 'bad' : ''}">(${vary ? 'almeno ' : ''}${pct > 0 ? '−' : '+'}${nf0.format(Math.abs(pct))} %)</span>` : '');
    const tt = predictTime();
    R.estT.innerHTML = `${vary ? '<small class="vary">variabile, circa</small>' : ''}<span class="v">≈ ${fmtTime(tt.s)} <small>m:ss</small></span>`;
    R.estSrc.textContent = `Tempo: velocità ${tt.measured ? 'dalla tua ultima compressione' : 'stima'} (~${nf0.format(tt.fps)} fps${st.settings.par2 ? `, ${st.settings.par3 ? 3 : 2} player` : ', 1 player'})${vary ? `, ×${nf1.format(SCENE_TIME_FACTOR)} per le prove per scena` : ''}${resApplies(st.settings.res, st.file) !== 'orig' ? ` · uscita ${st.settings.res}p (estrazione dalla sorgente, peso in proporzione ai pixel)` : ''}.`;
    R.estSrc.hidden = false;
    if (pct != null && pct < 10) {
      R.warn.hidden = false;
      R.warn.textContent = 'Questo video è già leggero: con questo bitrate il risparmio sarà minimo o nullo. Prova un valore più basso.';
    }
  }
  root.querySelector('.fcv-step-set').addEventListener('change', syncSettings);

  // ---------- miniature (v0.38.4) ----------
  // v0.38.7: nessun <video>: app/lib/thumb.js (Mediabunny + VideoDecoder, un pacchetto) → canvas 96 px → JPEG. Cache in memoria per id; mai durante un export.
  const thumbs = new Map(); let thumbBusy = false;
  const thumbOk = () => !st.busy || (st.qMode && !st.qCur); // mai durante un export (tra una voce e l'altra sì)
  const thumbQ = [];
  async function thumbPump() {
    if (thumbBusy || !thumbOk()) return; const job = thumbQ.shift(); if (!job) return;
    thumbBusy = true; const u = await makeThumb(job.blob); thumbBusy = false;
    if (job.key !== 'single' && !thumbs.has(job.key)) { /* voce rimossa nel frattempo */ } else thumbs.set(job.key, u || 'err');
    job.cb?.(u); if (job.key !== 'single') paintThumbs(); thumbPump();
  }
  function thumbFor(key, blob, cb) { if (!blob || thumbs.has(key) && key !== 'single') return; if (key !== 'single') thumbs.set(key, 'wait'); thumbQ.push({ key, blob, cb }); thumbPump(); }
  function paintThumbs() { R.qList.querySelectorAll('.fcv-q-item').forEach((li) => { const u = thumbs.get(+li.dataset.qid), im = li.querySelector('.fcv-q-thumb'); if (im && u && u !== 'wait' && u !== 'err') { im.innerHTML = `<img src="${u}" alt="">`; } else if (im && u === 'err') im.dataset.err = '1'; }); }
  function thumbSync(items) { const ids = new Set(items.map((it) => it.id)); for (const k of [...thumbs.keys()]) if (!ids.has(k)) thumbs.delete(k); for (let i = thumbQ.length - 1; i >= 0; i--) if (thumbQ[i].key !== 'single' && !ids.has(thumbQ[i].key)) thumbQ.splice(i, 1); for (const it of items) if (it.file && !thumbs.has(it.id)) thumbFor(it.id, it.file); }

  // ---------- coda (v0.36) ----------
  // Previsione di una voce con le impostazioni correnti (stesse formule del singolo: estimate.js).
  const itemFile = (it) => (it?.info?.dur ? { durationS: it.info.dur, width: it.info.W, height: it.info.H, fps: it.info.fps, aacBps: it.info.aacBps, apacBps: it.info.apacBps, sizeMB: it.sizeMB } : null);
  // v0.38.8: «già leggero» previsto PRIMA di comprimere: stessa regola del backend (worthRecompress, SCENE.keepRatio), con riduzione di risoluzione si comprime comunque.
  function lightInfo(it, f = itemFile(it)) {
    // v0.38.9: con la qualità per scena il limite è un tetto (prove spesso 2–5 Mbps): «già leggero» si decide solo dopo le prove (worthAfterTrials)
    const s = st.settings; if (s.sceneQ || !f?.sizeMB || !f.durationS || resApplies(s.res, f) !== 'orig') return null;
    const aud = f.aacBps === 0 ? 0 : (f.aacBps > 0 ? f.aacBps : 256000) + (s.apac && f.apacBps > 0 ? f.apacBps : 0);
    const src = f.sizeMB * 1048576 * 8 / f.durationS - aud; if (!(src > 0)) return null;
    const w = worthRecompress(src, s.bitrateMbps * 1e6); if (!w.keep) return { keep: false };
    const hint = [...BITRATES].reverse().find((b) => b < s.bitrateMbps && !worthRecompress(src, b * 1e6).keep);
    const pct = hint ? (1 - estimateOutBytes({ durS: f.durationS, videoMbps: hint, audioMode: s.audioMode, aacBps: f.aacBps, apacBps: s.apac ? f.apacBps : 0 }) / 1048576 / f.sizeMB) * 100 : null;
    return { keep: true, srcMbps: src / 1e6, hint, pct };
  }
  function predictItem(it) {
    const f = itemFile(it); if (!f) return null; const s = st.settings;
    const L = lightInfo(it, f);
    const mb = L?.keep ? f.sizeMB : estimateOutBytes({ durS: f.durationS, videoMbps: s.bitrateMbps, pixelRatio: pixRatio(s, f), audioMode: s.audioMode, aacBps: f.aacBps, apacBps: s.apac ? f.apacBps : 0 }) / 1048576;
    const t = estimateTimeS({ durS: f.durationS, fps: f.fps, audioMode: s.audioMode, par2: parN(s), width: f.width, height: f.height, sceneQ: s.sceneQ, downscale: resApplies(s.res, f) !== 'orig', mode: s.mode, res: resApplies(s.res, f) });
    return { mb, s: L?.keep ? 0 : (t?.s ?? null), pct: f.sizeMB ? (1 - mb / f.sizeMB) * 100 : null, light: L };
  }
  const needsFile = (it) => !it.hasFile && ['attesa', 'corso', 'errore', 'annullata'].includes(it.status);
  const isPending = (it) => it.status === 'attesa' || it.status === 'corso';
  function queueTotals() {
    const items = st.queue?.items || [], pend = items.filter(isPending);
    let inMB = 0, mb = 0, t = 0, unknown = 0;
    for (const it of pend) { const p = predictItem(it); inMB += it.sizeMB; if (p) { mb += p.mb; t += p.s || 0; } else unknown++; }
    return { n: items.length, pend: pend.length, inMB, mb, t, unknown };
  }
  function updateQueueEstimate() {
    R.warn.hidden = true;
    const T = queueTotals(), vary = st.settings.sceneQ;
    if (!T.pend) { R.est.innerHTML = R.estT.innerHTML = '—'; R.estSrc.textContent = 'Nessun video in attesa.'; R.estSrc.hidden = false; return; }
    if (T.unknown === T.pend) { R.est.innerHTML = R.estT.innerHTML = '…'; R.estSrc.hidden = true; return; }
    const pct = T.inMB ? (1 - T.mb / T.inMB) * 100 : null;
    R.est.innerHTML = `<small class="qv">${T.pend} video${vary ? ', al massimo' : ''}${T.unknown ? ` (${T.pend - T.unknown} letti)` : ''}</small><span class="v">${vary ? '≤' : '≈'} ${fmtMB(T.mb)} <small>MB</small></span>` + (pct != null && !T.unknown ? ` <span class="save ${pct <= 0 ? 'bad' : ''}">(${pct > 0 ? '−' : '+'}${nf0.format(Math.abs(pct))} %)</span>` : '');
    R.estT.innerHTML = `<small class="qv">in totale${vary ? ', variabile' : ''}</small><span class="v">≈ ${fmtTime(T.t)} <small>m:ss</small></span>`;
    R.estSrc.textContent = `Previsione per tutta la coda (${T.pend} video in attesa), uno dopo l'altro. Le stime per video sono nella lista.`; R.estSrc.hidden = false;
  }
  const chip = (t, c = '') => `<span class="px-chip${c ? ' ' + c : ''}">${t}</span>`;
  function itemHTML(it, i) {
    const inf = it.info, p = isPending(it) ? predictItem(it) : null, r = it.result, nf = needsFile(it), vary = st.settings.sceneQ;
    const chips = [];
    if (inf?.hdr) chips.push(chip('HDR', 'px-chip--hdr'));
    if (inf?.dv) chips.push(chip('DV', 'px-chip--dv'));
    if (inf?.W) chips.push(chip(esc(resLabel(inf.W, inf.H)), 'px-chip--num'));
    if (inf?.dur) chips.push(chip(fmtTime(inf.dur), 'px-chip--num'));
    chips.push(chip(`${fmtMB(it.sizeMB)} MB`, 'px-chip--num'));
    let stTxt = '', act = '';
    if (nf) stTxt = `<b class="fcv-q-badge" data-k="warn">Da riselezionare</b>${it.status === 'attesa' && (it.interrupted || it.resume) ? ' riprende dai segmenti già pronti' : ''}`;
    else if (it.status === 'attesa') stTxt = `<b class="fcv-q-badge">In attesa</b>${it.resume ? ` riprende dal segmento ${it.resume.done + 1}/${it.resume.total}` : it.interrupted ? ' interrotto: riprende dai segmenti già pronti' : ''}${it.lost ? ' risultato perso: da ricomprimere' : ''}`;
    else if (it.status === 'corso') stTxt = `<b class="fcv-q-badge" data-k="run">In corso</b> <span class="fcv-q-pct px-digits">${Math.max(0, st.lastPct)} %</span>`;
    else if (it.status === 'fatto' && r?.kept) stTxt = `<b class="fcv-q-badge" data-k="off">${r.kept === 'light' ? 'Già leggero' : 'Non conviene'}</b> <span class="fcv-q-res">${esc(r.kept === 'light' ? 'tenuto l\'originale' : 'non conviene ricomprimere: tenuto l\'originale')} · ${fmtMB(r.inMB)} MB</span>`;
    else if (it.status === 'fatto' && r) stTxt = `<b class="fcv-q-badge" data-k="ok">Fatto</b> <span class="fcv-q-res">${r.pct >= 0 ? '−' : '+'}${nf0.format(Math.abs(r.pct))} % · ${fmtMB(r.outMB)} MB · ${fmtTime(r.timeS)}</span>${it.saved ? ' <span class="fcv-q-saved">✓ salvato</span>' : ''}`;
    else if (it.status === 'errore') stTxt = `<b class="fcv-q-badge" data-k="bad">Errore</b> <span class="fcv-q-err">${esc(it.error || '')}</span>`;
    else if (it.status === 'annullata') stTxt = '<b class="fcv-q-badge" data-k="off">Annullata</b>';
    if (it.status === 'fatto' && it.hasOut && !it.saved) act += `<button class="px-btn px-btn--ok" type="button" data-act="save" data-id="${it.id}">Salva nelle Foto</button>`;
    if ((it.status === 'errore' || it.status === 'annullata')) act += `<button class="px-btn" type="button" data-act="retry" data-id="${it.id}">Riprova</button>`;
    const L = p?.light, light = L?.keep ? `<p class="fcv-q-st"><b class="fcv-q-badge" data-k="off">Già leggero</b> <span class="fcv-q-res">verrà tenuto l'originale (${nf1.format(L.srcMbps)} Mbps ≤ ${SCENE.keepRatio}× ${st.settings.bitrateMbps})${L.hint && L.pct > 0 ? ` · a ${L.hint} Mbps: ≈ −${nf0.format(L.pct)} %` : ''}</span></p>` : '';
    const est = L?.keep ? `<p class="fcv-q-est">→ = originale · ${fmtMB(p.mb)} MB</p>${light}` : p ? `<p class="fcv-q-est">→ ${vary ? '≤' : '≈'} ${fmtMB(p.mb)} MB${p.pct != null ? ` (${p.pct > 0 ? '−' : '+'}${nf0.format(Math.abs(p.pct))} %)` : ''} · ≈ ${fmtTime(p.s)}</p>` : isPending(it) && !inf && it.hasFile ? '<p class="fcv-q-est">lettura…</p>' : '';
    const orig = inf?.exported ? `<p class="fcv-q-orig">Copia ricodificata da Foto (${esc(inf.exported[0] || '')}). Meglio l'originale: Foto › Condividi › Opzioni › «Attuale» › Salva in File.</p>` : '';
    const bad = inf?.error && isPending(it) ? `<p class="fcv-q-orig">Non leggibile: ${esc(inf.error)}</p>` : '';
    const tu = thumbs.get(it.id), th = `<span class="fcv-q-thumb"${tu === 'err' ? ' data-err="1"' : ''}>${tu && tu !== 'wait' && tu !== 'err' ? `<img src="${tu}" alt="">` : sprite(SPRITES.film, { scale: 3 })}</span>`;
    return `<li class="fcv-q-item" data-qid="${it.id}" data-st="${it.status}"${nf ? ' data-nf' : ''}>${th}<div class="fcv-q-body">
      <div class="fcv-q-head"><span class="fcv-q-n">${i + 1}</span><b class="fcv-q-name">${esc(it.name)}</b>${it.status !== 'corso' ? `<button class="px-btn fcv-q-x" type="button" data-act="rm" data-id="${it.id}" aria-label="Rimuovi ${esc(it.name)} dalla coda" title="Rimuovi dalla coda">${sprite(SPRITES.trash, { scale: 2 })}</button>` : ''}</div>
      <div class="fcv-chips">${chips.join('')}</div>${est}
      <p class="fcv-q-st">${stTxt}</p>${it.status === 'corso' ? `<div class="px-bar fcv-q-bar" style="--p:${Math.max(0, st.lastPct) / 100}"><i></i></div>` : ''}${orig}${bad}${act ? `<div class="fcv-q-btns">${act}</div>` : ''}
    </div></li>`;
  }
  function renderQueue() {
    const q = st.queue; if (!q) return;
    const items = q.items, T = queueTotals(), S = items.filter((it) => it.status === 'fatto' && it.result);
    R.qCount.textContent = `${items.length}`;
    { const sh = srcShort(); if (sh !== st.resShort) { st.resShort = sh; buildRes(); st.settings = readSettings(); syncResBox(); } }
    thumbSync(items);
    R.qList.innerHTML = items.map(itemHTML).join('');
    R.qMsg.hidden = !q.msg; if (q.msg) { R.qMsg.textContent = q.msg.text; R.qMsg.dataset.kind = q.msg.kind || ''; }
    const doneIn = S.reduce((a, it) => a + it.result.inMB, 0), doneOut = S.reduce((a, it) => a + it.result.outMB, 0);
    R.qTot.innerHTML = `<b>${items.length} video</b>` + (T.pend ? ` · in attesa ${T.pend}: ${fmtMB(T.inMB)} → ${st.settings.sceneQ ? '≤' : '≈'} ${T.unknown === T.pend ? '…' : fmtMB(T.mb)} MB · ≈ ${fmtTime(T.t)}` : '') + (S.length ? ` · fatti ${S.length}: ${fmtMB(doneIn)} → ${fmtMB(doneOut)} MB` : '');
    const miss = items.filter(needsFile).length;
    R.qRelinkBox.hidden = !miss; R.qRelinkTxt.textContent = `Riseleziona i video (${miss})`;
    R.qClear.hidden = !!q.running;
    if (st.qCur) { // video aggiunti o rimossi durante il lavoro: «Video n di N» aggiornato
      const i = items.findIndex((x) => x.id === st.qCur.id);
      if (i >= 0) { st.qCur.idx = i + 1; st.qCur.n = items.length; const c = R.summary.querySelector('[data-qchip]'); if (c) c.textContent = `${st.qCur.idx}/${st.qCur.n}`; }
    }
    // nuovo lavoro dopo la fine della coda (Riprova, video aggiunti o riselezionati) → di nuovo «Comprimi N video»
    if (st.stage === 'done' && !st.busy && items.some((it) => it.status === 'attesa' && it.hasFile)) setStage('ready');
    if (st.stage === 'done') renderQueueDone();
    syncGo(); if (!st.busy) updateQueueEstimate();
  }
  R.qList.addEventListener('click', (e) => { // SINCRONO nel tap: «Salva» apre la share sheet
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = +b.dataset.id, it = st.queue?.items.find((x) => x.id === id), act = b.dataset.act;
    if (act === 'save') handlers.onQueueSave?.(id);
    else if (act === 'retry') handlers.onQueueRetry?.(id);
    else if (act === 'rm') {
      if (it?.status === 'fatto' && it.hasOut && !it.saved && !confirm(`Il video compresso «${it.name}» non è ancora salvato nelle Foto. Toglierlo dalla coda e perderlo?`)) return;
      handlers.onQueueRemove?.(id);
    }
  });
  R.qdFiles.addEventListener('click', (e) => { const b = e.target.closest('button[data-act="save"]'); if (b) handlers.onQueueSave?.(+b.dataset.id); });
  const unsaved = () => (st.queue?.items || []).filter((it) => it.status === 'fatto' && it.hasOut && !it.saved).length;
  const clearAsk = () => { const n = unsaved(); if (n && !confirm(`${n === 1 ? 'Un video compresso non è ancora salvato' : `${n} video compressi non sono ancora salvati`} nelle Foto: svuotare la coda e perderli?`)) return; handlers.onQueueClear?.(); };
  R.qClear.addEventListener('click', clearAsk);
  R.qNew.addEventListener('click', clearAsk);
  R.qRedo.addEventListener('click', () => {
    const n = unsaved(); if (n && !confirm(`${n === 1 ? 'Un video compresso non è ancora salvato' : `${n} video compressi non sono ancora salvati`} nelle Foto: rifare la coda con altre impostazioni e perderli?`)) return;
    handlers.onQueueRedo?.(); setStage('ready'); root.querySelector('.fcv-step-set')?.scrollIntoView?.({ block: 'start' });
  });
  R.qStop.addEventListener('click', () => { R.qStop.disabled = true; R.qStop.textContent = 'Mi fermo…'; R.cancel.disabled = true; handlers.onQueueStop?.(); });
  R.qSaveAll.addEventListener('click', () => handlers.onQueueSaveAll?.()); // sincrono: share sheet con tutti i file
  function renderQueueDone() {
    const items = st.queue?.items || [], S = items.filter((it) => it.status === 'fatto' && it.result);
    const inMB = S.reduce((a, it) => a + it.result.inMB, 0), outMB = S.reduce((a, it) => a + it.result.outMB, 0), tS = S.reduce((a, it) => a + (it.result.timeS || 0), 0);
    const pMB = S.reduce((a, it) => a + (it.result.predMB || 0), 0), pS = S.reduce((a, it) => a + (it.result.predS || 0), 0);
    const err = items.filter((it) => it.status === 'errore').length, pct = inMB ? (1 - outMB / inMB) * 100 : 0;
    const one = items.length === 1 && items[0].status === 'fatto' && !!items[0].result; // v0.38.5: coda da 1 video → risultato pulito, niente tabella
    R.qdScroll.hidden = one; R.qdOne.hidden = !one;
    if (one) {
      const it = items[0], r = it.result, inf = it.info, bits = [];
      if (inf?.hdr) bits.push(chip('HDR', 'px-chip--hdr')); if (inf?.dv) bits.push(chip('DV', 'px-chip--dv'));
      if (inf?.W) bits.push(chip(esc(resLabel(inf.W, inf.H)), 'px-chip--num')); if (inf?.dur) bits.push(chip(fmtTime(inf.dur), 'px-chip--num')); if (inf?.fps) bits.push(chip(`${Math.round(inf.fps)} fps`, 'px-chip--num'));
      const row = (k, v) => `<div class="fcv-cmp-row"><span class="px-label">${k}</span><span class="v">${v}</span></div>`;
      R.qdOne.innerHTML = `<p class="fcv-qd-onename">${esc(it.name)}</p><div class="fcv-chips">${bits.join('')}</div>` + (r.kept
        ? `<p class="fcv-subtle">${r.kept === 'light' ? 'Già leggero' : 'Non conviene ricomprimere'}: tenuto l'originale (${fmtMB(r.inMB)} MB).</p>`
        : row('Prima', `${fmtMB(r.inMB)} MB`) + row('Dopo', `${fmtMB(r.outMB)} MB${r.predMB ? ` <small>(previsto ≈${fmtMB(r.predMB)})</small>` : ''}`) + row('Tempo', `${fmtTime(r.timeS)}${r.predS ? ` <small>(previsto ≈${fmtTime(r.predS)})</small>` : ''}`)
          + (r.sceneBr ? `<p class="fcv-subtle">Bitrate per scena: ${nf1.format(r.sceneBr.min)}–${nf1.format(r.sceneBr.max)} Mbps, medio ${nf1.format(r.sceneBr.mean)} Mbps</p>` : '') + `<p class="fcv-outname">${esc(r.outName || '')}</p>`);
    }
    R.qdTitle.textContent = one ? 'Fatto!' : err ? (S.length ? 'Coda finita, ma…' : 'Coda finita con errori') : 'Coda finita!';
    R.qdBig.textContent = S.length ? `${pct >= 0 ? '−' : '+'}${nf0.format(Math.abs(pct))}%` : '—'; R.qdBig.classList.toggle('neg', pct < 0);
    R.qdSub.textContent = one ? (S[0].result.kept ? 'tenuto l\'originale' : 'più leggero') : S.length ? `${S.length} video · ${fmtMB(inMB)} → ${fmtMB(outMB)} MB${err ? ` · ${err} con errore` : ''}` : `${err} video con errore`;
    R.qdBody.innerHTML = items.map((it) => {
      const r = it.result, nm = `<th scope="row"><span class="fcv-qd-name">${esc(it.name)}</span>`;
      if (it.status === 'fatto' && r?.kept) return `<tr>${nm}<small>da ${fmtMB(r.inMB)} MB</small></th><td colspan="2" class="fcv-qd-st">${r.kept === 'light' ? 'già leggero' : 'non conviene'}: tenuto l'originale</td><td>${fmtTime(r.timeS)}</td></tr>`;
      if (it.status === 'fatto' && r) return `<tr>${nm}<small>da ${fmtMB(r.inMB)} MB</small></th><td>${fmtMB(r.outMB)}${r.predMB ? `<small>≈${fmtMB(r.predMB)}</small>` : ''}</td><td class="${r.pct >= 0 ? 'ok' : 'bad'}">${r.pct >= 0 ? '−' : '+'}${nf0.format(Math.abs(r.pct))}</td><td>${fmtTime(r.timeS)}${r.predS ? `<small>≈${fmtTime(r.predS)}</small>` : ''}</td></tr>`;
      return `<tr>${nm}</th><td colspan="3" class="fcv-qd-st">${esc({ errore: 'errore', annullata: 'annullata', attesa: 'non fatta', corso: 'interrotta' }[it.status] || it.status)}</td></tr>`;
    }).join('');
    R.qdFoot.innerHTML = S.length > 1 ? `<tr><th scope="row">Totale<small>da ${fmtMB(inMB)} MB</small></th><td>${fmtMB(outMB)}${pMB ? `<small>≈${fmtMB(pMB)}</small>` : ''}</td><td class="${pct >= 0 ? 'ok' : 'bad'}">${pct >= 0 ? '−' : '+'}${nf0.format(Math.abs(pct))}</td><td>${fmtTime(tS)}${pS ? `<small>≈${fmtTime(pS)}</small>` : ''}</td></tr>` : '';
    R.qdCap.textContent = S.length ? 'Reale e, sotto, previsto (≈)' : '';
    const toSave = items.filter((it) => it.status === 'fatto' && it.hasOut && !it.saved);
    R.qSaveAll.disabled = !toSave.length;
    R.qSaveAllTxt.textContent = toSave.length ? (toSave.length === 1 ? 'Salva nelle Foto' : `Salva tutti nelle Foto (${toSave.length})`) : S.length ? 'Tutti salvati ✓' : 'Niente da salvare';
    R.qdFiles.hidden = !(st.qShareFb && toSave.length);
    R.qdFiles.innerHTML = toSave.map((it) => `<button class="px-btn px-btn--ok px-btn--block" type="button" data-act="save" data-id="${it.id}">Salva ${esc(it.name)}</button>`).join('');
    R.qdNote.hidden = !(S.length && pMB && Math.abs(outMB / pMB - 1) > 0.15);
    R.qdNote.textContent = 'Peso reale lontano più del 15 % dalla previsione: la stima usa un bitrate medio fisso, ma scene molto semplici o molto movimentate pesano diversamente.';
  }

  // ---------- passo 3: via ----------
  R.go.addEventListener('click', () => {
    if ((!st.file && !st.qMode) || st.busy) return;
    st.settings = readSettings();
    startProgress();
    handlers.onStart?.({ ...st.settings });
  });
  R.retry.addEventListener('click', () => { startProgress(); handlers.onStart?.({ ...st.settings }); });
  // Riprendi: impostazioni del job salvato (devono coincidere per riusare i segmenti), poi via come «Comprimi».
  R.resumeBtn.addEventListener('click', () => {
    if (!st.file || st.busy || !st.resume) return;
    writeSettings({ ...readSettings(), ...st.resume.settings });
    st.settings = readSettings();
    startProgress();
    handlers.onStart?.({ ...st.settings, resume: true });
  });
  function setResume(r) {
    st.resume = r || null;
    R.resume.hidden = !st.resume;
    if (!st.resume) return;
    const s = st.resume.settings || {};
    R.resumeText.textContent = `Trovato un export interrotto di questo video (${s.bitrateMbps} Mbps${s.sceneQ ? ' max, qualità per scena' : ''}${s.res && s.res !== 'orig' ? `, ${s.res}p` : s.downscale ? ', 1080p' : ''}, key ${s.keyframeS}s): ${st.resume.done} segmenti su ${st.resume.total} già pronti.`;
    R.resumeBtn.textContent = `Riprendi export di ${st.resume.name} (segmenti ${st.resume.done}/${st.resume.total})`;
  }
  R.again.addEventListener('click', () => { setStage('ready'); root.querySelector('.fcv-step-set').scrollIntoView({ block: 'start' }); });
  R.cancel.addEventListener('click', () => {
    st.cancelling = true; R.cancel.disabled = true; R.cancel.textContent = 'Annullo…';
    handlers.onCancel?.();
  });

  // ---------- avanzamento ----------
  let keepShown = false; // avviso «schermo acceso» una sola volta per sessione
  function startProgress({ keepLog = false } = {}) {
    st.predMB = predictMB(); st.predT = predictTime()?.s; st.vt0 = st.vt1 = st.vtEnd = 0; st.lastElapsed = 0; R.tline.hidden = true; st.par2Used = parN(st.settings); st.sceneUsed = st.settings.sceneQ; st.dsUsed = resApplies(st.settings.res, st.file) !== 'orig'; st.modeUsed = st.settings.mode; st.resUsed = resApplies(st.settings.res, st.file); st.phase = null; st.overall = 0; st.lastPct = -1; st.result = null; st.t0 = performance.now();
    if (!keepLog) clearLog();
    const s = st.settings;
    R.qNow.hidden = true;
    const full = `${st.file?.name || 'video'} · ${s.sceneQ ? `per scena ≤ ${s.bitrateMbps}` : s.bitrateMbps} Mbps · key ${s.keyframeS}s${s.res && s.res !== 'orig' ? ` · ${s.res}p` : ''}${s.mode === 'sdr' ? ' · SDR' : s.mode === 'hdr8' ? ' · HDR 8 bit' : ''} · ${AUDIO_SHORT[s.audioMode] || s.audioMode}`;
    const short = [s.mode === 'sdr' ? 'SDR' : s.mode === 'hdr8' ? 'HDR8' : 'HDR10', `${s.sceneQ ? '≤' : ''}${s.bitrateMbps}M`, s.sceneQ ? 'scena' : '', s.res && s.res !== 'orig' ? `${s.res}p` : ''].filter(Boolean).join(' · ');
    R.summary.title = full; R.summary.innerHTML = `<span class="fcv-sum-name">${esc(st.file?.name || 'video')}</span><span class="fcv-sum-set">${esc(short)}</span>`;
    ['eta', 'fps', 'frames'].forEach((k) => { R[k].textContent = '—'; });
    R.elapsed.textContent = '0:00';
    R.progNote.textContent = keepShown ? '' : KEEP_OPEN; keepShown = true; R.progNote.hidden = !R.progNote.textContent; R.progNote.dataset.kind = ''; st.pipOn = false; R.pipBox.hidden = true;
    renderPct(0);
    setPhase('analisi');
    setStage('busy');
    root.dataset.busy = 'true';
    if (!keepLog || st.qCur?.idx === st.qFirstIdx) R.prog.scrollIntoView?.({ block: 'start' });
  }
  // PiP (v0.21): visibile dalla fase video in poi, solo se supportata; in PWA standalone solo una nota (bug WebKit 303885).
  const standalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } };
  function updatePip() {
    const late = st.phase && st.phase !== 'analisi' && st.phase !== 'fatto' && st.phase !== 'errore';
    const show = !!(late && st.busy && document.pictureInPictureEnabled);
    const sa = standalone();
    R.pipBox.hidden = !show; R.pipBtn.hidden = sa;
    R.pipNote.hidden = !(show && sa);
    R.pipNote.textContent = 'Per il background apri il sito in Safari (la PiP qui non funziona).';
    R.pipBtn.title = st.pipOn ? 'Finestrella aperta: puoi usare altre app.' : 'Puoi usare altre app finché la finestrella resta aperta.';
    R.pipBtn.textContent = st.pipOn ? 'Chiudi Picture-in-Picture' : 'Continua in Picture-in-Picture';
  }
  // v0.35.3: dall'app installata, tasto «Apri in Safari» (lì funziona la PiP). iOS: schema x-safari-https:// (apre Safari);
  // se dopo ~1 s la pagina è ancora visibile, ripiego: link copiato negli appunti da incollare in Safari.
  if (standalone()) {
    R.safariBtn.hidden = false;
    R.safariBtn.addEventListener('click', () => {
      const url = location.href.split('#')[0];
      try { location.href = 'x-safari-' + url; } catch {}
      setTimeout(() => {
        if (document.visibilityState !== 'visible') return;
        const ok = () => { R.safariMsg.textContent = 'Link copiato: incollalo in Safari. Un export interrotto qui non si riprende in Safari (dati separati).'; };
        const ko = () => { R.safariMsg.textContent = `Apri Safari e vai su ${url}`; };
        try { navigator.clipboard?.writeText ? navigator.clipboard.writeText(url).then(ok, ko) : ko(); } catch { ko(); }
      }, 1000);
    });
  }
  R.pipBtn.addEventListener('click', () => handlers.onPip?.(!!st.pipOn)); // SINCRONO nel tap: requestPictureInPicture richiede il gesto
  function setPhase(p) {
    if (st.phase === p) return;
    const idx = PHASES.findIndex((x) => x.id === p);
    if (idx < 0) return;
    // le fasi saltate contano come completate
    st.overall = Math.max(st.overall, PHASES.slice(0, idx).reduce((a, x) => a + WEIGHT[x.id], 0));
    st.phase = p; updatePip();
    const ph = PHASES[idx];
    R.phIcon.innerHTML = sprite(SPRITES[ph.icon || p], { scale: 4 });
    R.phName.textContent = ph.label;
    R.phSub.textContent = ph.sub;
    R.chain.querySelectorAll('li').forEach((li, i) => { li.dataset.s = i < idx ? 'done' : i === idx ? 'now' : ''; });
    R.live.textContent = `Fase: ${ph.label}`;
    renderPct(st.overall);
  }
  function renderPct(f) {
    const pct = Math.max(0, Math.min(100, Math.floor(f * 100)));
    R.bar.style.setProperty('--p', String(Math.min(1, f)));
    if (pct !== st.lastPct) {
      st.lastPct = pct;
      R.pct.innerHTML = `${pct}<small>%</small>`;
      R.bar.setAttribute('aria-valuenow', String(pct));
      if (st.qCur) { const li = R.qList.querySelector(`[data-qid="${st.qCur.id}"]`); if (li) { const t = li.querySelector('.fcv-q-pct'), b = li.querySelector('.fcv-q-bar'); if (t) t.textContent = `${pct} %`; if (b) b.style.setProperty('--p', String(pct / 100)); } }
    }
  }
  let pendingProg = null;
  function onProgress(d) {
    pendingProg = d;
    if (st.rafPending) return;
    st.rafPending = requestAnimationFrame(() => { st.rafPending = null; const x = pendingProg; pendingProg = null; if (x) applyProgress(x); });
  }
  function applyProgress(d) {
    if (st.stage !== 'busy') return;
    if (d.phase && d.phase !== st.phase) setPhase(d.phase);
    const p = st.phase, frac = d.total > 0 ? Math.min(1, d.done / d.total) : 0;
    const before = PHASES.slice(0, PHASES.findIndex((x) => x.id === p)).reduce((a, x) => a + WEIGHT[x.id], 0);
    st.overall = Math.max(st.overall, before + (WEIGHT[p] || 0) * frac);
    renderPct(st.overall);
    const elapsed = Number.isFinite(d.elapsedS) ? d.elapsedS : (performance.now() - st.t0) / 1000;
    R.elapsed.textContent = fmtTime(elapsed);
    let eta = d.etaS;
    if (!Number.isFinite(eta) && st.overall > 0.03) eta = elapsed * (1 - st.overall) / st.overall;
    R.eta.textContent = fmtTime(eta);
    if (p === 'video') { if (!st.vt0 && d.done > 0) st.vt0 = elapsed; st.vt1 = elapsed; st.vFrames = d.total; } else if (st.vt0 && !st.vtEnd) st.vtEnd = elapsed;
    st.lastElapsed = elapsed;
    if (st.predT > 0) { R.tline.hidden = false; R.tline.textContent = `Previsto ${fmtTime(st.predT)} · residuo ${fmtTime(eta)}`; }
    if (Number.isFinite(d.fps)) R.fps.innerHTML = `${nf0.format(d.fps)}<small>fps</small>`;
    if (p === 'video' && d.total) R.frames.innerHTML = `${nf0.format(d.done)}<small>/${nf0.format(d.total)}</small>`;
  }

  // ---------- risultato ----------
  function showResult(r) {
    if (pendingProg) { const x = pendingProg; pendingProg = null; applyProgress(x); } // ultimo avanzamento ancora in coda
    st.result = r;
    R.save.hidden = !!r.kept;
    if (r.kept) { // v0.37.4: nessun file prodotto (sorgente già leggera o risultato non più leggero): si tiene l'originale
      R.doneTitle.textContent = r.kept === 'light' ? 'Già leggero' : 'Non conviene';
      R.big.textContent = '—'; R.big.classList.remove('neg');
      R.bigSub.textContent = 'tenuto l\'originale';
      R.inMB.textContent = R.outMB.textContent = `${fmtMB(r.inMB)} MB`; R.afterBar.style.setProperty('--p', '1');
      R.freed.textContent = r.kept === 'light' ? `Il video è già leggero${r.srcMbps ? ` (${nf1.format(r.srcMbps)} Mbps)` : ''}: ricomprimerlo farebbe risparmiare poco e peggiorerebbe la qualità. Nessun file nuovo: tieni l'originale.`
        : 'Il file ricompresso non pesava meno dell\'originale: non te lo propongo. Tieni l\'originale (o prova un bitrate più basso).';
      R.pred.hidden = R.predNote.hidden = R.sceneBr.hidden = true; R.outName.textContent = ''; R.saveMsg.textContent = '';
      setStage('done'); R.done.scrollIntoView?.({ block: 'start' }); return;
    }
    const saved = Number.isFinite(r.savedPct) ? r.savedPct : (1 - r.outMB / r.inMB) * 100;
    R.big.textContent = `${saved >= 0 ? '−' : '+'}${nf0.format(Math.abs(saved))}%`;
    R.big.classList.toggle('neg', saved < 0);
    R.bigSub.textContent = saved >= 0 ? 'più leggero' : 'più pesante dell\'originale';
    R.doneTitle.textContent = saved >= 0 ? 'Fatto!' : 'Fatto, ma…';
    R.inMB.textContent = `${fmtMB(r.inMB)} MB`;
    R.outMB.textContent = `${fmtMB(r.outMB)} MB`;
    R.afterBar.style.setProperty('--p', String(Math.max(0.02, Math.min(1, r.outMB / r.inMB))));
    const freed = r.inMB - r.outMB;
    R.freed.innerHTML = freed > 0 ? `Hai liberato <b>${fmtMB(freed)} MB</b> <span class="sep">·</span> <span class="nw">${nf1.format(r.inMB / r.outMB)}× più piccolo</span>` : 'Il video originale era già molto compresso: prova un bitrate più basso.';
    R.pred.hidden = R.predNote.hidden = true;
    const sb = r.sceneBr; R.sceneBr.hidden = !sb; // «qualità per scena»: riga «bitrate per scena: min–max, medio»
    if (sb) R.sceneBr.textContent = `Bitrate per scena: ${nf1.format(sb.min)}–${nf1.format(sb.max)} Mbps, medio ${nf1.format(sb.mean)} Mbps`;
    const realT = st.lastElapsed || (performance.now() - st.t0) / 1000, devOf = (a, b) => (b / a - 1) * 100;
    const fmtDev = (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${nf1.format(Math.abs(v))}%`;
    const setDev = (el, v) => { el.textContent = fmtDev(v); el.className = Math.abs(v) <= 10 ? 'ok' : 'warnc'; };
    if (st.predMB > 0) {
      const dev = devOf(st.predMB, r.outMB);
      R.pW1.textContent = fmtMB(st.predMB); R.pW2.textContent = fmtMB(r.outMB); setDev(R.pW3, dev);
      let tl = '', devT = null;
      if (st.predT > 0 && realT > 0) {
        devT = devOf(st.predT, realT);
        R.pT1.textContent = fmtTime(st.predT); R.pT2.textContent = fmtTime(realT); setDev(R.pT3, devT);
        tl = ` | tempo previsto ${fmtTime(st.predT)} · reale ${fmtTime(realT)} · scarto ${devT > 0 ? '+' : '−'}${nf1.format(Math.abs(devT))} %`;
        learnSpeed(realT);
      } else { R.pT1.textContent = R.pT2.textContent = R.pT3.textContent = '—'; R.pT3.className = ''; }
      R.pred.hidden = false;
      R.predSum.textContent = `peso ${fmtDev(dev)}${devT != null ? `, tempo ${fmtDev(devT)}` : ''}`;
      if (st.sceneUsed) { R.predNote.textContent = 'Qualità per scena: la previsione del peso è il massimo (bitrate scelto come limite); ogni tratto ha ricevuto solo il bitrate che gli serviva.'; R.predNote.hidden = false; }
      else if (Math.abs(dev) > 15) { R.predNote.textContent = 'Scarto peso oltre il 15%: la previsione usa un bitrate medio fisso, ma scene molto semplici o molto movimentate pesano diversamente.'; R.predNote.hidden = false; }
      appendLog(`PREVISIONE: peso ${st.predMB.toFixed(2)} MB previsto · ${r.outMB.toFixed(2)} MB reale · scarto ${dev > 0 ? '+' : ''}${dev.toFixed(1)} %${tl}`, 'summary');
    }
    R.outName.textContent = r.fileName || '';
    R.saveMsg.textContent = '';
    setStage('done');
    R.done.removeAttribute('data-pop'); void R.done.offsetWidth; R.done.setAttribute('data-pop', '');
    if (saved > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches) confetti();
    R.done.scrollIntoView?.({ block: 'start' });
  }
  // misura reale: frame totali / secondi della fase video (estrazione + codifica) → prossima previsione (anche per ogni voce della coda)
  function learnSpeed(realT) {
    const vs = (st.vtEnd || st.vt1) - st.vt0;
    // con le prove per scena la fase video non misura la velocità di codifica: niente salvataggio
    if (st.vFrames > 0 && vs > 1 && !st.sceneUsed) saveSpeed({ par2: st.par2Used, width: st.file?.width, height: st.file?.height, downscale: st.dsUsed, mode: st.modeUsed, res: st.resUsed }, st.vFrames / vs, realT);
  }
  function confetti(el = R.confetti) {
    const cols = ['--px-yellow', '--px-lime', '--px-sky', '--px-orange', '--px-red', '--px-cyan'];
    el.innerHTML = Array.from({ length: 22 }, (_, i) => {
      const x = (i * 37) % 100, dx = ((i * 53) % 80) - 40, delay = (i % 7) * 70;
      return `<i style="left:${x}%;--dx:${dx}px;background:var(${cols[i % cols.length]});animation-delay:${delay}ms"></i>`;
    }).join('');
    setTimeout(() => { el.innerHTML = ''; }, 2400);
  }
  R.save.addEventListener('click', () => handlers.onSave?.()); // sincrono: la share sheet richiede il gesto dell'utente

  // ---------- errore ----------
  function showError(msg) {
    R.errMsg.textContent = msg || 'Errore sconosciuto.';
    setStage('error');
    R.logBox.open = true;
    R.err.scrollIntoView?.({ block: 'start' });
  }

  // ---------- log ----------
  // Archivio in memoria (con categorie e limite) + pannello che mostra solo le ultime righe, aggiornato a lotti.
  const LOG_TAIL = 300, LOG_ALL_MAX = 3000;
  const store = createLogStore({ max: 20000, head: 200 });
  let pend = [], flushT = 0, showAll = false;
  function scheduleFlush() {
    if (flushT) return;
    const go = () => { if (!flushT) return; cancelAnimationFrame(flushT.r); clearTimeout(flushT.t); flushT = 0; flushLog(); };
    flushT = { r: requestAnimationFrame(go), t: setTimeout(go, 400) }; // rAF si ferma a pagina nascosta: il timer garantisce comunque l'aggiornamento
  }
  function renderLogHead() {
    const tot = store.total, shown = R.log.childNodes.length;
    R.logCount.textContent = String(tot);
    R.logView.textContent = tot > shown ? `ultime ${shown} di ${tot} righe` : `${tot} righe`;
    R.logAll.disabled = !showAll && tot > LOG_ALL_MAX;
    R.logAll.title = R.logAll.disabled ? `Oltre ${LOG_ALL_MAX} righe: usa «Salva log completo (.txt)»` : '';
    R.logAll.textContent = showAll ? `Solo ultime ${LOG_TAIL}` : 'Mostra tutto';
    R.logAll.hidden = tot <= LOG_TAIL;
  }
  function flushLog() {
    if (store.total > LOG_ALL_MAX) showAll = false;
    const limit = showAll ? LOG_ALL_MAX : LOG_TAIL;
    if (pend.length > limit) pend = pend.slice(-limit);
    const frag = document.createDocumentFragment();
    for (const l of pend) { const d = document.createElement('div'); d.textContent = l; frag.append(d); }
    pend = [];
    R.log.append(frag);
    while (R.log.childNodes.length > limit) R.log.firstChild.remove();
    renderLogHead();
    if (R.logBox.open) R.log.scrollTop = R.log.scrollHeight;
  }
  function renderTail() { // dopo un cambio modalità: ricostruisce da archivio
    pend = []; R.log.textContent = '';
    const n = showAll ? LOG_ALL_MAX : LOG_TAIL, frag = document.createDocumentFragment();
    for (const e of store.tail(n)) { const d = document.createElement('div'); d.textContent = e.line; frag.append(d); }
    R.log.append(frag); renderLogHead();
  }
  function clearLog() { store.clear(); pend = []; R.log.textContent = ''; showAll = false; R.logSel.hidden = true; renderLogHead(); }
  function appendLog(line, cat, data) { // pend limitato: a pagina nascosta il flush può tardare (rAF fermo, timer rallentati)
    store.add(line, cat, data); pend.push(String(line)); if (pend.length > 2 * LOG_ALL_MAX) pend.splice(0, pend.length - LOG_ALL_MAX); scheduleFlush();
  }
  R.logAll.addEventListener('click', () => { if (R.logAll.disabled) return; showAll = !showAll; renderTail(); });

  function headerText() {
    const f = st.file || {}, s = st.settings, bits = [];
    if (st.qMode) { let set = ''; try { set = JSON.stringify(readSettings()); } catch {} return [`Compressore HDR ${opts.version || ''}`.trim(), `UA: ${navigator.userAgent}`, `Coda: ${(st.queue?.items || []).map((it) => `${it.name} (${fmtMB(it.sizeMB)} MB, ${it.status})`).join(' · ')}`, `Impostazioni: ${set}`].join('\n'); }
    if (f.width) bits.push(`${f.width}×${f.height}`);
    if (f.durationS) bits.push(`${Math.round(f.durationS)} s`);
    if (f.fps) bits.push(`${Math.round(f.fps)} fps`);
    if (f.hdr != null) bits.push(`HDR ${f.hdr ? 'sì' : 'no'}`);
    if (f.dolbyVision != null) bits.push(`DV ${f.dolbyVision ? 'sì' : 'no'}`);
    let set = ''; try { set = JSON.stringify(readSettings()); } catch { set = JSON.stringify(s); }
    return [`Compressore HDR ${opts.version || ''}`.trim(), `UA: ${navigator.userAgent}`,
      `File: ${f.name || '—'}${f.sizeMB ? ` · ${f.sizeMB.toFixed(1)} MB` : ''}${bits.length ? ' · ' + bits.join(' · ') : ''}`, `Impostazioni: ${set}`].join('\n');
  }
  function copyLog() {
    if (handlers.onCopyLog) { handlers.onCopyLog(); return; }
    const t = store.summaryText(headerText());
    const fallback = () => { // selezione di un textarea (funziona anche su iOS) con il riassunto
      R.logSel.value = t; R.logSel.hidden = false; R.logSel.focus(); R.logSel.select(); try { R.logSel.setSelectionRange(0, t.length); } catch {}
      setSaveCopyMsg('Testo selezionato: tocca Copia');
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(() => { R.logSel.hidden = true; setSaveCopyMsg(`Copiato! (riassunto, ${t.split('\n').length} righe)`); }, fallback); else fallback();
  }
  function saveLogFile() { // sincrono nel tap: la share sheet richiede il gesto dell'utente
    const base = (st.qMode ? 'coda' : st.file?.name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w.\-]+/g, '_');
    const name = `${base}_log_${(opts.version || '').match(/v\d[\w.]*/)?.[0] || 'v'}.txt`;
    const file = new File([headerText() + '\n\n' + store.fullText() + '\n'], name, { type: 'text/plain' });
    const dl = () => { const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); };
    if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file] }).catch((e) => { if (e?.name !== 'AbortError') dl(); });
    else dl();
  }
  R.saveLog.addEventListener('click', saveLogFile);
  function setSaveCopyMsg(t) { R.copyMsg.textContent = t; clearTimeout(st.copyT); st.copyT = setTimeout(() => { R.copyMsg.textContent = ''; }, 3000); }
  R.copy.addEventListener('click', copyLog);
  R.errCopy.addEventListener('click', () => { R.logBox.open = true; copyLog(); });

  // ---------- spazio occupato (v0.37.1): la logica sta in app/lib/storage.js, qui solo la vista ----------
  const STATE_TXT = { inuse: 'in uso', resumable: 'riprendibile', unsaved: 'da salvare', free: 'libero' };
  function syncStorage() {
    const m = st.storage, off = st.busy || !m;
    R.stFree.disabled = off || !m.freeBytes; R.stAll.disabled = off;
    R.stBody.querySelectorAll('button[data-sact]').forEach((b) => { b.disabled = st.busy || b.dataset.state === 'inuse'; });
  }
  function setStorage(m) {
    st.storage = m || null; if (!m) return;
    R.stLine.textContent = m.line; R.stCount.textContent = m.count; R.stEst.textContent = m.est || '';
    R.stBody.textContent = '';
    for (const g of m.groups) {
      const h = document.createElement('h4'); h.className = 'fcv-st-h'; h.textContent = g.title; R.stBody.append(h);
      for (const r of g.rows) {
        const row = document.createElement('div'); row.className = 'fcv-st-row';
        const t = document.createElement('span'); t.className = 'fcv-st-name'; t.textContent = r.label;
        const sz = document.createElement('span'); sz.className = 'fcv-st-size'; sz.textContent = r.size;
        const tag = document.createElement('span'); tag.className = 'px-chip fcv-st-tag'; tag.dataset.state = r.state; tag.textContent = STATE_TXT[r.state] || r.state;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'px-btn'; b.textContent = 'Elimina'; b.dataset.sact = 'del'; b.dataset.id = r.id; b.dataset.state = r.state;
        row.append(t, sz, tag, b); R.stBody.append(row);
      }
    }
    if (!m.groups.length) R.stBody.textContent = 'Niente da mostrare.';
    syncStorage();
  }
  const askStorage = () => handlers.onStorageOpen?.();
  R.stBox.addEventListener('toggle', () => { if (R.stBox.open) askStorage(); });
  R.stDet.addEventListener('toggle', () => { if (R.stDet.open) askStorage(); });
  R.stFree.addEventListener('click', () => handlers.onStorageAct?.('free'));
  R.stAll.addEventListener('click', () => handlers.onStorageAct?.('all'));
  R.stBody.addEventListener('click', (e) => { const b = e.target.closest?.('button[data-sact]'); if (b && !b.disabled) handlers.onStorageAct?.('del', b.dataset.id); });

  // ---------- «i» (spiegazioni lunghe), About ----------
  root.addEventListener('click', (e) => {
    const b = e.target.closest?.('.fcv-i'); if (!b) return;
    e.preventDefault(); const d = b.closest('.fcv-radio')?.querySelector('.fcv-d'); if (!d) return;
    d.hidden = !d.hidden; b.setAttribute('aria-expanded', String(!d.hidden));
  });
  // BUILD_ID «0.37.4-20261127T012743Z» → data/ora locali (Roma); senza buildId si usa l'etichetta della testata («v0.37.4 · 27/11 02:27»).
  function aboutInfo() {
    const lbl = String(opts.version || ''), id = String(opts.buildId || ''), m = id.match(/^(.+?)-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/);
    let when = lbl.split('·')[1]?.trim() || '', ver = (lbl.match(/v?\d[\w.]*/) || [''])[0] || (m ? m[1] : '');
    if (m) { try { when = new Date(Date.UTC(+m[2], m[3] - 1, +m[4], +m[5], +m[6], +m[7])).toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' }); } catch {} if (!ver) ver = m[1]; }
    return { ver: ver ? (/^v/.test(ver) ? ver : 'v' + ver) : '—', build: [id, when].filter(Boolean).join(' · ') || '—' };
  }
  const openAbout = () => { const a = aboutInfo(); R.abVer.textContent = a.ver; R.abBuild.textContent = a.build; try { R.about.showModal(); } catch { R.about.setAttribute('open', ''); } };
  const closeAbout = () => { try { R.about.close(); } catch { R.about.removeAttribute('open'); } };
  R.verBtn.addEventListener('click', openAbout);
  R.abClose.addEventListener('click', closeAbout);
  R.about.addEventListener('click', (e) => { if (e.target === R.about) closeAbout(); }); // tocco sullo sfondo
  const gotoBox = (box) => () => { closeAbout(); box.open = true; setTimeout(() => box.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 50); };
  R.abLog.addEventListener('click', gotoBox(R.logBox));
  R.abStore.addEventListener('click', gotoBox(R.stBox));

  // ---------- bus ----------
  const subs = {
    phase: (d) => {
      if (d.phase === 'errore') { if (st.stage !== 'error') showError(st.lastError || 'La compressione si è interrotta.'); return; }
      if (d.phase === 'fatto') { renderPct(1); return; }
      if (st.stage !== 'busy') startProgress();
      setPhase(d.phase);
    },
    progress: onProgress,
    result: showResult,
    log: (d) => appendLog(d.line ?? '', d.cat, d.data),
    error: (d) => { st.lastError = d.message; showError(d.message); },
  };
  const listeners = Object.entries(subs).map(([t, fn]) => { const h = (e) => fn(e.detail || {}); bus.addEventListener(t, h); return [t, h]; });

  writeSettings(DEFAULTS);
  setStage('pick');
  root.dataset.busy = 'false'; root.dataset.queue = 'false';

  return {
    setBusy,
    /** Spazio occupato: {line, count, est, freeBytes, groups:[{title, rows:[{id,label,size,state}]}]} (stringhe già formattate). */
    setStorage,
    setStorageMessage(t) { R.stMsg.textContent = t || ''; clearTimeout(st.stT); st.stT = setTimeout(() => { R.stMsg.textContent = ''; }, 4000); },
    /** PiP (v0.21): {active} → etichetta del pulsante «Continua / Chiudi Picture-in-Picture». */
    setPip(active) { st.pipOn = !!active; updatePip(); },
    setDefaults(s = {}) { Object.assign(DEFAULTS, s); writeSettings({ ...readSettings(), ...s }); },
    // --- estensioni ---
    getSettings: () => readSettings(),
    /** Offerta di ripresa per il file scelto: {name, done, total, settings} oppure null (nasconde). */
    setResume,
    /** Messaggio nel pannello di avanzamento (default «Tieni l'app aperta…»); kind '' | 'warn' | 'bad'. Testo vuoto = default. */
    setProgNote(text, kind = '') { R.progNote.textContent = text || ''; R.progNote.hidden = !text; R.progNote.dataset.kind = text ? kind : ''; },
    /** Messaggio sotto "Salva nelle Foto" (es. esito della share sheet). */
    setSaveMessage(text) { R.saveMsg.textContent = text || ''; },
    /** Messaggio accanto a "Copia log" (utile se onCopyLog è gestito dall'app). */
    setCopyMessage: setSaveCopyMsg,
    /** Testo completo del log (tutte le righe in archivio). */
    getLog: () => store.fullText(),
    /** Riassunto compatto (intestazione + setup + warn/error + segmenti aggregati + PiP al minuto + summary). */
    getLogSummary: () => store.summaryText(headerText()),
    /** Coda (v0.36): true = la lista della coda sostituisce la scheda del singolo video; false = torna al passo 1 vuoto. */
    setQueueMode(on) {
      st.qMode = !!on; root.dataset.queue = String(st.qMode); st.qShareFb = false;
      if (st.qMode) { st.file = null; setResume(null); R.pick.hidden = true; R.queue.hidden = false; if (st.stage === 'pick' || st.stage === 'done' || st.stage === 'error') setStage('ready'); }
      else { st.queue = null; st.qCur = null; R.queue.hidden = true; R.pick.hidden = false; R.qNow.hidden = true; if (!st.busy) setStage('pick'); }
      resetCancel(); syncSettings();
    },
    /** Vista della coda dall'app: {running, curId, msg:{text,kind}|null, items:[{id,name,sizeMB,status,info,result,error,saved,hasFile,hasOut,interrupted,lost,resume}]}. */
    setQueue(v) { st.queue = v || null; if (v) renderQueue(); else { thumbs.clear(); thumbQ.length = 0; } },
    /** Inizio della coda (dopo setBusy(true)): log già azzerato, nessuna voce corrente. */
    queueStart() { st.qCur = null; st.qFirstIdx = null; st.qShareFb = false; resetCancel(); },
    /** Inizio di una voce: {id, idx, n, name, sizeMB, durationS?, width?, height?, fps?, …} → pannello di avanzamento azzerato (il log resta). */
    queueItemStart(m) {
      if (st.qFirstIdx == null) st.qFirstIdx = m.idx;
      st.qCur = m; st.file = { ...m }; st.cancelling = false; resetCancel();
      st.settings = readSettings(); startProgress({ keepLog: true });
      R.summary.insertAdjacentHTML('afterbegin', `<span class="fcv-sum-q px-digits" data-qchip>${m.idx}/${m.n}</span>`);
    },
    /** Voce finita: impara la velocità per le previsioni successive. */
    queueItemDone(id, r) { if (pendingProg) { const x = pendingProg; pendingProg = null; applyProgress(x); } learnSpeed(r?.timeS || st.lastElapsed); st.qCur = null; thumbPump(); },
    /** Fine coda: schermata «Coda finita!» con tabella e «Salva tutti nelle Foto». */
    showQueueDone() { st.qCur = null; setStage('done'); renderQueueDone(); R.qdone.removeAttribute('data-pop'); void R.qdone.offsetWidth; R.qdone.setAttribute('data-pop', ''); if (!matchMedia('(prefers-reduced-motion: reduce)').matches && /^−/.test(R.qdBig.textContent)) confetti(R.qConfetti); R.qdone.scrollIntoView?.({ block: 'start' }); },
    /** «Salva tutti» non riuscito: un tasto per file nella schermata finale. */
    setQueueShareFallback(on) { st.qShareFb = !!on; renderQueue(); if (st.stage === 'done') renderQueueDone(); R.qdMsg.textContent = on ? 'Salvataggio insieme non riuscito: salva un video alla volta con i tasti qui sotto.' : ''; },
    /** Applica impostazioni (es. quelle salvate con la coda). */
    applySettings(s = {}) { writeSettings({ ...readSettings(), ...s }); },
    /** Torna al passo 1 (nessun file). */
    reset() { thumbs.clear(); thumbQ.length = 0; st.file = null; setResume(null); st.qMode = false; st.queue = null; root.dataset.queue = 'false'; R.queue.hidden = true; R.pick.hidden = false; setBusy(false); setStage('pick'); updateEstimate(); },
    destroy() { for (const [t, h] of dndTargets) window.removeEventListener(t, h); listeners.forEach(([t, h]) => bus.removeEventListener(t, h)); root.innerHTML = ''; },
  };
}
