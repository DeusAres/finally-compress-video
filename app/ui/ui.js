// UI pixel art di finally-compress-video. Contratto: app/ui/README.md.
// mountUI(root, handlers) → { setBusy, setDefaults, getSettings, setSaveMessage, reset } (+ coda v0.36: setQueueMode, setQueue, …)
import { bus } from './bus.js?v=0.36.1';
import { sprite, SPRITES } from './sprite.js?v=0.36.1';
import { createLogStore } from './logstore.js?v=0.36.1';
import { estimateOutBytes, SCENE_TIME_FACTOR, estimateTimeS, saveSpeed } from './estimate.js?v=0.36.1';

const BITRATES = [4, 6, 8, 10, 12, 14];
const KEYFRAMES = [1, 4, 10];
const BR_INFO = {
  4: { q: 2, t: 'Molto leggero: dettagli e ombre si impastano. Solo per chat.' },
  6: { q: 3, t: 'Leggero: bene sullo schermo del telefono, qualche difetto nelle scene mosse.' },
  8: { q: 4, t: 'Consigliato: quasi identico all\'originale (VMAF ~89). Il risparmio dipende dal video: vedi la stima qui accanto.' },
  10: { q: 4, t: 'Più margine per scene difficili: acqua, foglie, coriandoli, movimento.' },
  12: { q: 5, t: 'Qualità alta, risparmio moderato.' },
  14: { q: 5, t: 'Quasi trasparente: serve solo con originali molto dettagliati.' },
};
const KF_INFO = {
  1: 'Scorrimento e montaggio precisissimi, file un po\' più pesante.',
  4: 'Equilibrio consigliato tra peso e scorrimento.',
  10: 'File un filo più leggero, scorrimento meno preciso.',
};
const AUDIO = [
  { v: 'copy', b: 'Copia originale', t: 'Nessuna perdita, istantaneo. Consigliato.' },
  { v: 'v4', b: 'Ripara eco v4', t: 'Se l\'audio ha un\'eco o un rimbombo digitale (es. dopo un Comando Rapido). Analizza tutto il file.' },
  { v: 'v3', b: 'Ripara eco v3', t: 'Versione precedente: adattiva, canali L+R.', dev: true },
  { v: 'v2', b: 'Ripara eco v2', t: 'Versione precedente: filtro per frequenza.', dev: true },
  { v: 'v1', b: 'Ripara eco v1', t: 'Prima versione, la più semplice.', dev: true },
  { v: 'reenc', b: 'Solo ricodifica', t: 'Diagnostica: ricodifica AAC senza filtri.', dev: true },
];
const KEEP_OPEN = 'Tieni l\'app aperta e lo schermo acceso finché finisce.';
const AUDIO_SHORT = { copy: 'audio originale', v4: 'eco v4', v3: 'eco v3', v2: 'eco v2', v1: 'eco v1', reenc: 'audio ricodificato' };
const PHASES = [
  { id: 'analisi', label: 'Analisi', sub: 'Leggo tracce, colori e Dolby Vision' },
  { id: 'video', label: 'Video', sub: 'Ricodifico i fotogrammi in HEVC 10-bit, a segmenti riprendibili' },
  { id: 'assemblaggio', label: 'Unione', sub: 'Assemblaggio: unisco i segmenti video nel file', icon: 'film' },
  { id: 'audio', label: 'Audio', sub: 'Preparo la traccia audio' },
  { id: 'scrittura', label: 'File', sub: 'Assemblo il file e i metadati' },
];
const WEIGHT = { analisi: 0.04, video: 0.82, assemblaggio: 0.04, audio: 0.07, scrittura: 0.03 };
const DEFAULTS = { bitrateMbps: 8, keyframeS: 4, audioMode: 'copy', bgAudio: false, par2: true, sceneQ: true, apac: true, container: 'mov' }; // container: 'mov' (QuickTime, come gli originali iPhone, v0.34) | 'mp4' // apac: audio spaziale + metadati iPhone (mebx) mantenuti (v0.32/v0.33, solo se la sorgente li ha) // par2 ON da v0.24 (verificato su iPhone, anche con PiP; fallback automatico)

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
  const brSeg = BITRATES.map((b) => `<label><input type="radio" name="fcv-br" value="${b}"${b === 8 ? ' aria-label="8 Mbps, consigliato"' : ''}><span>${b === 8 ? `<i class="star">${s('star', { scale: 2 })}</i>` : ''}${b}<small>Mbps</small></span></label>`).join('');
  const kfSeg = KEYFRAMES.map((k) => `<label><input type="radio" name="fcv-kf" value="${k}"><span>${k}<small>sec</small></span></label>`).join('');
  const audio = AUDIO.map((a) => `<label class="fcv-radio"${a.dev ? ' data-dev' : ''}><input type="radio" name="fcv-audio" value="${a.v}"><div><b>${a.b}</b><span>${a.t}</span></div></label>`).join('');
  const chain = PHASES.map((p) => `<li data-p="${p.id}">${s(p.icon || p.id, { scale: 2 })}<span>${p.label}</span></li>`).join('');
  return `
<header class="fcv-head">
  ${s('logo', { scale: 4, className: 'fcv-logo px-bob', title: 'Logo' })}
  <h1 class="px-title">Finally <b>Compress<span class="fcv-cursor px-blink"></span></b></h1>
  <p>Video HDR e Dolby Vision dell'iPhone, più leggeri. Tutto resta sul telefono.${opts.version ? ` <span class="px-chip px-chip--num">${esc(opts.version)}</span>` : ''}</p>
  <p class="fcv-open-safari" data-ref="safariBox" hidden><button type="button" class="px-btn" data-ref="safariBtn">Apri in Safari</button> <span data-ref="safariMsg" role="status" aria-live="polite">Nella scheda di Safari funziona la Picture-in-Picture.</span></p>
</header>

<ol class="fcv-steps" aria-label="Passi">
  <li data-step="1"><span class="n">1</span><span class="t">Scegli</span></li>
  <li data-step="2"><span class="n">2</span><span class="t">Regola</span></li>
  <li data-step="3"><span class="n">3</span><span class="t">Comprimi</span></li>
</ol>

<div class="fcv-drop" data-ref="drop" hidden aria-hidden="true">${s('film', { scale: 8, className: 'px-bob' })}<b class="px-title">Rilascia qui i video</b><span>Più video = una coda, compressi uno alla volta</span></div>

<section class="px-panel fcv-card fcv-step-file" aria-labelledby="fcv-h1">
  <header><span class="num">1</span><h2 class="px-title" id="fcv-h1">Scegli il video</h2></header>
  <label class="fcv-pick" data-ref="pick">
    <input type="file" accept="video/*,.mov,.mp4" multiple data-ref="input" aria-label="Scegli uno o più video">
    ${s('film', { scale: 7, className: 'px-bob' })}
    <span class="fcv-pick-cta">Tocca per scegliere</span>
    <small>Uno o più video: con più video si crea una coda, compressi uno dopo l'altro.</small>
    <small>Da «Scegli file» (app File) il video arriva intatto; da «Libreria foto» iOS può consegnare una copia ricodificata. Nessun caricamento: il video non lascia l'iPhone.</small>
  </label>
  <p class="fcv-drop-msg" data-ref="dropMsg" role="status" aria-live="polite" hidden></p>
  <div class="fcv-file" data-ref="fileBox" hidden>
    <div class="fcv-file-name">${s('film', { scale: 4 })}<div><strong data-ref="fName"></strong><div class="fcv-chips" data-ref="fChips"></div></div></div>
    <div class="fcv-stats">
      <div class="fcv-stat"><span class="px-label">Peso</span><span class="v px-digits" data-ref="fSize">—</span></div>
      <div class="fcv-stat"><span class="px-label">Durata</span><span class="v px-digits" data-ref="fDur">—</span></div>
      <div class="fcv-stat"><span class="px-label">Formato</span><span class="v px-digits" data-ref="fRes">—</span></div>
    </div>
    <p class="fcv-warn fcv-orig" data-ref="origNote" role="status" hidden></p>
    <div class="fcv-file-actions"><label class="px-btn fcv-relabel">Aggiungi altri video<input type="file" accept="video/*,.mov,.mp4" multiple data-ref="qAddSingle" aria-label="Aggiungi altri video (coda)"></label><label class="px-btn fcv-relabel" data-ref="change">Cambia video<input type="file" accept="video/*,.mov,.mp4" multiple data-ref="input2" aria-label="Cambia video"></label></div>
  </div>
</section>

<section class="px-panel fcv-card fcv-queue" data-ref="queue" hidden aria-labelledby="fcv-hq">
  <header><span class="num">1</span><h2 class="px-title" id="fcv-hq">Coda di video</h2><span class="px-chip px-chip--num fcv-q-count" data-ref="qCount">0</span></header>
  <p class="fcv-q-msg" data-ref="qMsg" role="status" aria-live="polite" hidden></p>
  <p class="fcv-q-tot" data-ref="qTot" aria-live="polite"></p>
  <ol class="fcv-q-list" data-ref="qList" aria-label="Video in coda"></ol>
  <div class="fcv-q-actions">
    <label class="px-btn px-btn--primary fcv-relabel" data-ref="qRelinkBox" hidden><span data-ref="qRelinkTxt">Riseleziona i video</span><input type="file" accept="video/*,.mov,.mp4" multiple data-ref="qRelink" aria-label="Riseleziona i video della coda"></label>
    <label class="px-btn fcv-relabel">Aggiungi video<input type="file" accept="video/*,.mov,.mp4" multiple data-ref="qAdd" aria-label="Aggiungi video alla coda"></label>
    <button class="px-btn" type="button" data-ref="qClear">Svuota coda</button>
  </div>
  <p class="fcv-subtle">I video si comprimono uno alla volta, nell'ordine in cui li hai aggiunti; quelli aggiunti mentre lavora vanno in fondo. Le impostazioni valgono per tutta la coda.</p>
</section>

<section class="px-panel fcv-card fcv-step-set" aria-labelledby="fcv-h2">
  <header><span class="num">2</span><h2 class="px-title" id="fcv-h2">Regola la qualità</h2></header>
  <fieldset class="fcv-field">
    <legend class="px-label">Bitrate video</legend>
    <div class="px-seg fcv-seg-br" data-ref="br">${brSeg}</div>
    <p class="fcv-hint" data-ref="brHint" aria-live="polite"></p>
  </fieldset>
  <div class="fcv-meters">
    <div class="fcv-meter fcv-meter--wide"><span class="px-label">Qualità</span><div class="fcv-hearts" data-ref="hearts"></div></div>
  </div>
  <table class="fcv-tbl fcv-est-tbl" aria-live="polite"><caption class="px-label">Previsione</caption><tbody>
    <tr><th scope="row">Peso</th><td data-ref="est">—</td></tr>
    <tr><th scope="row">Tempo</th><td data-ref="estT">—</td></tr>
  </tbody></table>
  <p class="fcv-subtle" data-ref="estSrc" hidden></p>
  <p class="fcv-warn" data-ref="warn" hidden></p>
  <details class="fcv-adv">
    <summary>${s('chevron', { scale: 2, className: 'chev' })}<span class="fcv-sum-txt"><b>Opzioni avanzate</b><span class="fcv-adv-sum" data-ref="advSum"></span></span></summary>
    <fieldset class="fcv-field">
      <legend class="px-label">Fotogramma chiave ogni</legend>
      <div class="px-seg" data-ref="kf">${kfSeg}</div>
      <p class="fcv-hint" data-ref="kfHint"></p>
    </fieldset>
    <fieldset class="fcv-field">
      <legend class="px-label">Audio</legend>
      <div class="fcv-radios" data-ref="audio">${audio}</div>
      <p class="fcv-subtle">Le voci "versione precedente" e "diagnostica" servono per confronti tecnici.</p>
    </fieldset>
    <fieldset class="fcv-field" data-ref="apacBox" hidden>
      <legend class="px-label">Tracce iPhone</legend>
      <label class="fcv-radio"><input type="checkbox" name="fcv-apac" value="1" checked><div><b>Mantieni audio spaziale e metadati iPhone</b><i>(video registrati con iPhone)</i><span>Copia invariate la traccia audio spaziale e le tracce di metadati dell'iPhone (orientamento, volti, Live Photo, luminosità della scena, «cinematic-audio»), come nell'originale: in Foto restano l'audio spaziale e «Mix audio». L'audio spaziale (e la sua traccia «cinematic-audio») solo con l'audio «copia»: con la riparazione dell'eco o la ricodifica viene tolto, i metadati video restano. Audio spaziale ~0,4 Mbps, metadati trascurabili.</span></div></label>
    </fieldset>
    <fieldset class="fcv-field">
      <legend class="px-label">Contenitore</legend>
      <div class="fcv-radios">
        <label class="fcv-radio"><input type="radio" name="fcv-container" value="mov" checked><div><b>MOV (come iPhone, consigliato)</b><span>File QuickTime .mov come gli originali dell'iPhone: le tracce di audio spaziale e metadati vengono riconosciute da Foto.</span></div></label>
        <label class="fcv-radio"><input type="radio" name="fcv-container" value="mp4"><div><b>MP4</b><span>File .mp4 (come fino alla v0.33), per programmi che non leggono il MOV.</span></div></label>
      </div>
    </fieldset>
    <fieldset class="fcv-field" data-ref="dsBox" hidden>
      <legend class="px-label">Risoluzione</legend>
      <label class="fcv-radio"><input type="checkbox" name="fcv-ds" value="1"><div><b>Riduci a 1080p (sperimentale, oggi non funziona)</b><i>(su Safari 27 l'encoder riduce a 8 bit: HDR perso → oggi l'export si ferma)</i><span>Misurato su iPhone (Safari 27.0.1): quando è l'encoder di Safari a ridurre il 4K a 1080p l'uscita diventa 8 bit (HDR perso), quindi l'app ferma l'export con un messaggio invece di salvare un video senza HDR. Lascia l'opzione spenta: resta qui solo per riprovare dopo un aggiornamento di Safari. Se un giorno funzionasse: video a 1080×1920 (o 1920×1080) HDR a 10 bit, tempo come il 4K.</span></div></label>
    </fieldset>
    <fieldset class="fcv-field">
      <legend class="px-label">Sperimentale</legend>
      <label class="fcv-radio"><input type="checkbox" name="fcv-sceneq" value="1"><div><b>Qualità garantita per scena</b><i>(più lento: ~1,6× il tempo)</i><span>Prova più bitrate per ogni tratto e sceglie il minimo che resta «quasi perfetto» (VMAF stimato ≥ 88); più lento. Il bitrate scelto sopra diventa il limite massimo: il file non pesa mai più della stima.</span></div></label>
      <label class="fcv-radio"><input type="checkbox" name="fcv-bgaudio" value="1"><div><b>Test background con audio</b><i>(sperimentale: su iOS 27 non mantiene la decodifica in background)</i><span>Riproduce un audio quasi muto per provare a far continuare la compressione con l'app in background (controlli «In riproduzione»). Il log registra un battito al secondo e un riepilogo finale.</span></div></label>
      <label class="fcv-radio"><input type="checkbox" name="fcv-par2" value="1"><div><b>Estrazione parallela (2 player)</b><i>(~1,7× più veloce; se un player si blocca torna a 1 da solo)</i></div></label>
    </fieldset>
  </details>
</section>

<section class="px-panel fcv-card fcv-step-go" aria-labelledby="fcv-h3">
  <header><span class="num">3</span><h2 class="px-title" id="fcv-h3">Comprimi</h2></header>
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
    <div class="fcv-phase"><span data-ref="phIcon">${s('analisi', { scale: 4 })}</span><div><b id="fcv-hp" data-ref="phName">Analisi</b><span data-ref="phSub"></span></div></div>
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
  <p class="fcv-warn fcv-keep" data-ref="progNote" role="status" aria-live="polite">${KEEP_OPEN}</p>
  <div class="fcv-pip" data-ref="pipBox" hidden>
    <button class="px-btn px-btn--block" data-ref="pipBtn" type="button">Continua in Picture-in-Picture</button>
    <p class="fcv-pip-note" data-ref="pipNote">Puoi usare altre app: la compressione continua finché la finestrella resta aperta.</p>
  </div>
  <div class="fcv-cancels"><button class="px-btn px-btn--danger fcv-cancel" data-ref="cancel">Annulla</button><button class="px-btn fcv-cancel" data-ref="qStop" type="button" hidden>Ferma la coda</button></div>
  <p class="fcv-subtle fcv-q-stopnote" data-ref="qStopNote" hidden>«Annulla questo video» lo salta e la coda prosegue; «Ferma la coda» si ferma qui e il video in corso riprenderà dai segmenti già pronti.</p>
  <p class="px-sr" aria-live="polite" data-ref="live"></p>
</section>

<section class="px-panel fcv-done" data-ref="done" hidden aria-labelledby="fcv-hd">
  <div class="fcv-confetti" data-ref="confetti" aria-hidden="true"></div>
  <div class="fcv-done-title">${s('star', { scale: 4 })}<h2 class="px-title" id="fcv-hd" data-ref="doneTitle">Fatto!</h2>${s('star', { scale: 4 })}</div>
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
  <table class="fcv-tbl fcv-pred-tbl" data-ref="pred" hidden><thead><tr><th></th><th scope="col">Previsto</th><th scope="col">Reale</th><th scope="col">Scarto</th></tr></thead><tbody>
    <tr><th scope="row">Peso <small>MB</small></th><td data-ref="pW1"></td><td data-ref="pW2"></td><td data-ref="pW3"></td></tr>
    <tr><th scope="row">Tempo <small>m:ss</small></th><td data-ref="pT1"></td><td data-ref="pT2"></td><td data-ref="pT3"></td></tr>
  </tbody></table>
  <p class="fcv-pred-note" data-ref="predNote" hidden></p>
  <button class="px-btn px-btn--ok px-btn--xl px-btn--block" data-ref="save">${s('scrittura', { scale: 3 })}Salva nelle Foto</button>
  <p class="fcv-save-msg" data-ref="saveMsg" aria-live="polite"></p>
  <p class="fcv-outname" data-ref="outName"></p>
  <div class="fcv-done-more">
    <button class="px-btn" data-ref="again">Altre impostazioni</button>
    <label class="px-btn fcv-relabel">Nuovo video<input type="file" accept="video/*,.mov,.mp4" multiple data-ref="input3" aria-label="Scegli un nuovo video"></label>
  </div>
</section>

<section class="px-panel fcv-done fcv-qdone" data-ref="qdone" hidden aria-labelledby="fcv-hqd">
  <div class="fcv-confetti" data-ref="qConfetti" aria-hidden="true"></div>
  <div class="fcv-done-title">${s('star', { scale: 4 })}<h2 class="px-title" id="fcv-hqd" data-ref="qdTitle">Coda finita!</h2>${s('star', { scale: 4 })}</div>
  <div>
    <div class="fcv-big px-digits" data-ref="qdBig">−0%</div>
    <div class="fcv-big-sub" data-ref="qdSub"></div>
  </div>
  <table class="fcv-tbl fcv-qd-tbl"><caption class="fcv-subtle" data-ref="qdCap"></caption><thead><tr><th scope="col">Video</th><th scope="col">Dopo <small>MB</small></th><th scope="col">%</th><th scope="col">Tempo</th></tr></thead><tbody data-ref="qdBody"></tbody><tfoot data-ref="qdFoot"></tfoot></table>
  <p class="fcv-pred-note" data-ref="qdNote" hidden></p>
  <button class="px-btn px-btn--ok px-btn--xl px-btn--block" data-ref="qSaveAll">${s('scrittura', { scale: 3 })}<span data-ref="qSaveAllTxt">Salva tutti nelle Foto</span></button>
  <p class="fcv-save-msg" data-ref="qdMsg" aria-live="polite"></p>
  <div class="fcv-qd-files" data-ref="qdFiles" hidden></div>
  <div class="fcv-done-more">
    <button class="px-btn" type="button" data-ref="qNew">Nuova coda</button>
    <label class="px-btn fcv-relabel">Aggiungi video<input type="file" accept="video/*,.mov,.mp4" multiple data-ref="qAdd2" aria-label="Aggiungi video alla coda"></label>
  </div>
</section>

<section class="px-panel fcv-err" data-ref="err" hidden role="alert">
  <header>${s('errore', { scale: 4 })}<h2 class="px-title">Si è inceppato!</h2></header>
  <p class="fcv-err-msg" data-ref="errMsg"></p>
  <ul>
    <li>Tieni Safari in primo piano e lo schermo acceso durante la compressione.</li>
    <li>Chiudi le altre app pesanti e riprova; per video molto lunghi prova un bitrate più basso.</li>
    <li>Se si ripete, copia il log tecnico e mandalo.</li>
  </ul>
  <div class="fcv-row">
    <button class="px-btn px-btn--primary" data-ref="retry">Riprova</button>
    <button class="px-btn" data-ref="errCopy">Copia log</button>
  </div>
</section>

<details class="px-panel fcv-log" data-ref="logBox">
  <summary>${s('chevron', { scale: 2, className: 'chev' })}<b>Log tecnico</b><span class="px-chip count" data-ref="logCount">0</span></summary>
  <div class="fcv-log-view"><span data-ref="logView" aria-live="off"></span><button class="px-btn fcv-log-all" data-ref="logAll" type="button">Mostra tutto</button></div>
  <pre data-ref="log" tabindex="0"></pre>
  <textarea class="fcv-log-sel" data-ref="logSel" readonly hidden aria-label="Riassunto del log da copiare"></textarea>
  <div class="fcv-log-actions"><button class="px-btn" data-ref="copy">Copia log</button><button class="px-btn" data-ref="saveLog">Salva log completo (.txt)</button><span class="fcv-copy-msg" data-ref="copyMsg" aria-live="polite"></span></div>
</details>
<p class="fcv-foot">HEVC 10-bit · HDR · Dolby Vision · nessun upload</p>`;
}

/**
 * Monta la UI in `root`.
 * @param {HTMLElement} root
 * @param {{onFile?(f:File):void,onStart?(s:object):void,onCancel?():void,onSave?():void,onCopyLog?():void}} handlers
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
    const steps = { pick: ['now', '', ''], ready: ['done', 'now', ''], busy: ['done', 'done', 'now'], done: ['done', 'done', 'done'], error: ['done', 'done', 'now'] }[stage];
    root.querySelectorAll('.fcv-steps li').forEach((li, i) => {
      li.dataset.s = steps[i];
      li.querySelector('.n').innerHTML = steps[i] === 'done' ? sprite(SPRITES.check, { scale: 2 }) : String(i + 1);
      li.toggleAttribute('aria-current', steps[i] === 'now');
    });
    syncGo();
  }
  // Pulsante «Comprimi»: singolo video o coda («Comprimi N video»: voci in attesa con il loro file).
  function syncGo() {
    if (!st.qMode) {
      R.go.disabled = !st.file || st.busy;
      R.go.firstChild.textContent = 'Comprimi ';
      R.goNote.textContent = st.file ? 'Tieni Safari aperto e lo schermo acceso: la compressione avviene sul telefono.' : 'Scegli prima un video.';
      return;
    }
    const items = st.queue?.items || [], n = items.filter((it) => it.status === 'attesa' && it.hasFile).length, miss = items.filter(needsFile).length;
    R.go.disabled = st.busy || !n;
    R.go.firstChild.textContent = n ? `Comprimi ${n} ${n === 1 ? 'video' : 'video'} ` : 'Comprimi ';
    R.goNote.textContent = n ? `Uno alla volta, nell'ordine della coda. Tieni Safari aperto e lo schermo acceso.${miss ? ` ${miss} video da riselezionare: verranno saltati finché non li riselezioni.` : ''}`
      : miss ? 'Riseleziona i video della coda (passo 1) per continuare.' : 'Nessun video in attesa: aggiungine alla coda.';
  }
  function setBusy(b) {
    st.busy = !!b; if (!b) st.pipOn = false; updatePip();
    root.dataset.busy = String(st.busy);
    root.querySelectorAll('.fcv-step-set input, [data-ref^="input"]').forEach((i) => { i.disabled = st.busy; });
    syncGo();
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
    R.cancel.disabled = false; R.cancel.textContent = st.qMode ? 'Annulla questo video' : 'Annulla';
    R.qStop.hidden = R.qStopNote.hidden = !st.qMode; R.qStop.disabled = false; R.qStop.textContent = 'Ferma la coda';
  }

  // ---------- passo 1: file ----------
  function onPicked(e) {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (!files.length) return;
    takeFiles(files.filter(isVideo).length ? files.filter(isVideo) : files);
  }
  // Uno o più video scelti/trascinati: un video in modalità singola = come prima; più video (o coda già aperta) = coda.
  function takeFiles(files, { add = false, includeCurrent = false } = {}) {
    R.dropMsg.hidden = true;
    if (add || st.qMode || files.length > 1) { handlers.onQueueAdd?.(files, { includeCurrent }); return; }
    acceptFile(files[0]);
  }
  function acceptFile(f) {
    R.dropMsg.hidden = true; setResume(null);
    st.file = { name: f.name, sizeMB: f.size / 1048576 };
    showFile(st.file);
    clearLog();
    setStage('ready');
    handlers.onFile?.(f);
  }
  function showFile(fi) {
    R.pick.hidden = true; R.fileBox.hidden = false;
    R.fName.textContent = fi.name || 'video';
    R.fSize.innerHTML = fi.sizeMB != null ? `${fmtMB(fi.sizeMB)}<small>MB</small>` : '—';
    R.fDur.textContent = fi.durationS ? fmtTime(fi.durationS) : '—';
    R.fRes.textContent = resLabel(fi.width, fi.height) || '—';
    const chips = [];
    if (fi.hdr) chips.push('<span class="px-chip px-chip--hdr">HDR</span>');
    if (fi.dolbyVision) chips.push('<span class="px-chip px-chip--dv">Dolby Vision</span>');
    if (fi.apac) chips.push('<span class="px-chip">Audio spaziale</span>');
    if (fi.meta) chips.push('<span class="px-chip">Metadati iPhone</span>');
    if (fi.width && fi.height) chips.push(`<span class="px-chip px-chip--num">${fi.width}×${fi.height}</span>`);
    if (fi.fps) chips.push(`<span class="px-chip px-chip--num">${Math.round(fi.fps)} fps</span>`);
    R.fChips.innerHTML = chips.join('');
    // v0.35.5: copia ricodificata da Foto (Libreria foto / trascinamento) invece dell'originale → come ottenere l'originale
    R.origNote.hidden = !fi.exported;
    if (fi.exported) R.origNote.innerHTML = `Questa sembra la <b>copia ricodificata</b> che iOS consegna da «Libreria foto» o dal trascinamento, non l'originale (${fi.exported[0]}): di solito è ridotta (es. 4K → 1080p) e senza audio spaziale. Per comprimere l'originale: in <b>Foto</b> › Condividi › <b>Opzioni</b> › Formato «Attuale» › <b>Salva in File</b>; poi qui «Cambia video» › <b>Scegli file</b> e prendilo da File.`;
    syncDs(); // mostra/nasconde «Riduci a 1080p» e aggiorna le stime
  }
  // ---------- drag & drop (pagina intera; iPad/iPhone: trascinamento da Foto in Split View / Slide Over) ----------
  const isVideo = (f) => /^video\//.test(f.type) || /\.(mov|mp4|m4v|hevc)$/i.test(f.name || '');
  const hasFiles = (e) => { const t = e.dataTransfer?.types; return !!t && [...t].includes('Files'); };
  let dragDepth = 0;
  const dropOn = (on) => { R.drop.hidden = !on; root.classList.toggle('fcv-dragging', on); };
  const dropMessage = (t) => { R.dropMsg.textContent = t; R.dropMsg.hidden = false; };
  const canDrop = () => !st.busy || st.qMode; // durante la coda si possono aggiungere video (vanno in fondo)
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
  for (const k of ['input', 'input2', 'input3']) R[k].addEventListener('change', onPicked);
  const pickedTo = (o) => (e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) takeFiles(files, o); };
  for (const k of ['qAdd', 'qAdd2', 'qRelink']) R[k].addEventListener('change', pickedTo({ add: true }));
  R.qAddSingle.addEventListener('change', pickedTo({ add: true, includeCurrent: true }));

  // ---------- passo 2: impostazioni ----------
  // «Riduci a 1080p»: visibile/attivo solo se il lato corto della sorgente supera 1080 (default OFF)
  const dsAvailable = () => Math.min(st.file?.width || 0, st.file?.height || 0) > 1080;
  function syncDs() {
    const ok = dsAvailable(), c = root.querySelector('input[name="fcv-ds"]');
    R.dsBox.hidden = !ok; if (c) { c.disabled = !ok; if (!ok) c.checked = false; }
    R.apacBox.hidden = !(st.file?.apac || st.file?.meta); // «Mantieni audio spaziale e metadati iPhone»: solo se la sorgente ha apac o tracce mebx
    syncSettings();
  }
  function readSettings() {
    const v = (n) => root.querySelector(`input[name="${n}"]:checked`)?.value;
    return { bitrateMbps: +v('fcv-br') || DEFAULTS.bitrateMbps, keyframeS: +v('fcv-kf') || DEFAULTS.keyframeS, audioMode: v('fcv-audio') || DEFAULTS.audioMode, bgAudio: !!v('fcv-bgaudio'), par2: !!v('fcv-par2'), sceneQ: !!v('fcv-sceneq'), downscale: !!v('fcv-ds') && dsAvailable(), apac: !!v('fcv-apac'), container: v('fcv-container') === 'mp4' ? 'mp4' : 'mov' };
  }
  function writeSettings(s) {
    const set = (n, val) => { const i = root.querySelector(`input[name="${n}"][value="${val}"]`); if (i) i.checked = true; };
    set('fcv-br', s.bitrateMbps); set('fcv-kf', s.keyframeS); set('fcv-audio', s.audioMode);
    if (s.bgAudio != null) { const c = root.querySelector('input[name="fcv-bgaudio"]'); if (c) c.checked = !!s.bgAudio; }
    if (s.par2 != null) { const c = root.querySelector('input[name="fcv-par2"]'); if (c) c.checked = !!s.par2; }
    if (s.sceneQ != null) { const c = root.querySelector('input[name="fcv-sceneq"]'); if (c) c.checked = !!s.sceneQ; }
    if (s.downscale != null) { const c = root.querySelector('input[name="fcv-ds"]'); if (c) c.checked = !!s.downscale; }
    if (s.apac != null) { const c = root.querySelector('input[name="fcv-apac"]'); if (c) c.checked = !!s.apac; }
    if (s.container) set('fcv-container', s.container);
    syncSettings();
  }
  function syncSettings() {
    st.settings = readSettings();
    const { bitrateMbps: br, keyframeS: kf, audioMode: am } = st.settings;
    const info = BR_INFO[br] || BR_INFO[8];
    R.brHint.textContent = st.settings.sceneQ ? `Qualità per scena attiva: ${br} Mbps è il limite massimo, ogni tratto riceve il minimo che resta «quasi perfetto».` : info.t;
    R.hearts.innerHTML = Array.from({ length: 5 }, (_, i) => sprite(SPRITES[i < info.q ? 'heart' : 'heartEmpty'], { scale: 3 })).join('') + `<span class="px-sr">${info.q} su 5</span>`;
    R.kfHint.textContent = KF_INFO[kf] || '';
    if (st.qMode && st.queue) renderQueue();
    R.advSum.textContent = `${kf}s · ${AUDIO_SHORT[am] || am}${st.settings.bgAudio ? ' · test bg' : ''}${st.settings.par2 ? ' · 2 player' : ''}${st.settings.sceneQ ? ' · qualità per scena' : ''}${st.settings.downscale ? ' · 1080p' : ''}${st.settings.container === 'mp4' ? ' · MP4' : ' · MOV'}${st.file?.apac ? (st.settings.apac && am === 'copy' ? ' · spaziale' : ' · senza spaziale') : ''}${st.file?.meta && !st.file?.apac ? (st.settings.apac ? ' · metadati iPhone' : ' · senza metadati iPhone') : ''}`;
    updateEstimate();
  }
  const predictMB = (br = st.settings.bitrateMbps, d = st.file?.durationS) => (d ? estimateOutBytes({ durS: d, videoMbps: br, audioMode: st.settings.audioMode, aacBps: st.file?.aacBps, apacBps: st.settings.apac ? st.file?.apacBps : 0 }) / 1048576 : null); // formula in estimate.js
  const predictTime = () => { const f = st.file; return f?.durationS ? estimateTimeS({ durS: f.durationS, fps: f.fps, audioMode: st.settings.audioMode, par2: st.settings.par2, width: f.width, height: f.height, sceneQ: st.settings.sceneQ, downscale: st.settings.downscale }) : null; };
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
    R.estSrc.textContent = `Tempo: velocità ${tt.measured ? 'dalla tua ultima compressione' : 'stima'} (~${nf0.format(tt.fps)} fps${st.settings.par2 ? ', 2 player' : ', 1 player'})${vary ? `, ×${nf1.format(SCENE_TIME_FACTOR)} per le prove per scena` : ''}${st.settings.downscale ? ' · estrazione dal 4K, uscita 1080p (stessa durata del 4K)' : ''}.`;
    R.estSrc.hidden = false;
    if (pct != null && pct < 10) {
      R.warn.hidden = false;
      R.warn.textContent = 'Questo video è già leggero: con questo bitrate il risparmio sarà minimo o nullo. Prova un valore più basso.';
    }
  }
  root.querySelector('.fcv-step-set').addEventListener('change', syncSettings);

  // ---------- coda (v0.36) ----------
  // Previsione di una voce con le impostazioni correnti (stesse formule del singolo: estimate.js).
  const itemFile = (it) => (it?.info?.dur ? { durationS: it.info.dur, width: it.info.W, height: it.info.H, fps: it.info.fps, aacBps: it.info.aacBps, apacBps: it.info.apacBps, sizeMB: it.sizeMB } : null);
  function predictItem(it) {
    const f = itemFile(it); if (!f) return null; const s = st.settings;
    const mb = estimateOutBytes({ durS: f.durationS, videoMbps: s.bitrateMbps, audioMode: s.audioMode, aacBps: f.aacBps, apacBps: s.apac ? f.apacBps : 0 }) / 1048576;
    const t = estimateTimeS({ durS: f.durationS, fps: f.fps, audioMode: s.audioMode, par2: s.par2, width: f.width, height: f.height, sceneQ: s.sceneQ, downscale: s.downscale && Math.min(f.width, f.height) > 1080 });
    return { mb, s: t?.s ?? null, pct: f.sizeMB ? (1 - mb / f.sizeMB) * 100 : null };
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
    R.est.innerHTML = `<small class="vary">${T.pend} video${vary ? ', al massimo' : ''}${T.unknown ? ` (${T.pend - T.unknown} letti)` : ''}</small><span class="v">${vary ? '≤' : '≈'} ${fmtMB(T.mb)} <small>MB</small></span>` + (pct != null && !T.unknown ? ` <span class="save ${pct <= 0 ? 'bad' : ''}">(${pct > 0 ? '−' : '+'}${nf0.format(Math.abs(pct))} %)</span>` : '');
    R.estT.innerHTML = `<small class="vary">in totale${vary ? ', variabile' : ''}</small><span class="v">≈ ${fmtTime(T.t)} <small>m:ss</small></span>`;
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
    else if (it.status === 'fatto' && r) stTxt = `<b class="fcv-q-badge" data-k="ok">Fatto</b> <span class="fcv-q-res">${r.pct >= 0 ? '−' : '+'}${nf0.format(Math.abs(r.pct))} % · ${fmtMB(r.outMB)} MB · ${fmtTime(r.timeS)}</span>${it.saved ? ' <span class="fcv-q-saved">✓ salvato</span>' : ''}`;
    else if (it.status === 'errore') stTxt = `<b class="fcv-q-badge" data-k="bad">Errore</b> <span class="fcv-q-err">${esc(it.error || '')}</span>`;
    else if (it.status === 'annullata') stTxt = '<b class="fcv-q-badge" data-k="off">Annullata</b>';
    if (it.status === 'fatto' && it.hasOut && !it.saved) act += `<button class="px-btn px-btn--ok" type="button" data-act="save" data-id="${it.id}">Salva nelle Foto</button>`;
    if ((it.status === 'errore' || it.status === 'annullata')) act += `<button class="px-btn" type="button" data-act="retry" data-id="${it.id}">Riprova</button>`;
    const est = p ? `<p class="fcv-q-est">→ ${vary ? '≤' : '≈'} ${fmtMB(p.mb)} MB${p.pct != null ? ` (${p.pct > 0 ? '−' : '+'}${nf0.format(Math.abs(p.pct))} %)` : ''} · ≈ ${fmtTime(p.s)}</p>` : isPending(it) && !inf && it.hasFile ? '<p class="fcv-q-est">lettura…</p>' : '';
    const orig = inf?.exported ? `<p class="fcv-q-orig">Copia ricodificata da Foto, non l'originale (${esc(inf.exported[0] || '')}). Per l'originale: Foto › Condividi › Opzioni › «Attuale» › Salva in File, poi «Scegli file».</p>` : '';
    const bad = inf?.error && isPending(it) ? `<p class="fcv-q-orig">Non leggibile: ${esc(inf.error)}</p>` : '';
    return `<li class="fcv-q-item" data-qid="${it.id}" data-st="${it.status}"${nf ? ' data-nf' : ''}>
      <div class="fcv-q-head"><span class="fcv-q-n">${i + 1}</span><b class="fcv-q-name">${esc(it.name)}</b>${it.status !== 'corso' ? `<button class="px-btn fcv-q-x" type="button" data-act="rm" data-id="${it.id}" aria-label="Rimuovi ${esc(it.name)} dalla coda">Rimuovi</button>` : ''}</div>
      <div class="fcv-chips">${chips.join('')}</div>${est}
      <p class="fcv-q-st">${stTxt}</p>${it.status === 'corso' ? `<div class="px-bar fcv-q-bar" style="--p:${Math.max(0, st.lastPct) / 100}"><i></i></div>` : ''}${orig}${bad}${act ? `<div class="fcv-q-btns">${act}</div>` : ''}
    </li>`;
  }
  function renderQueue() {
    const q = st.queue; if (!q) return;
    const items = q.items, T = queueTotals(), S = items.filter((it) => it.status === 'fatto' && it.result);
    R.qCount.textContent = `${items.length}`;
    R.qList.innerHTML = items.map(itemHTML).join('');
    R.qMsg.hidden = !q.msg; if (q.msg) { R.qMsg.textContent = q.msg.text; R.qMsg.dataset.kind = q.msg.kind || ''; }
    const doneIn = S.reduce((a, it) => a + it.result.inMB, 0), doneOut = S.reduce((a, it) => a + it.result.outMB, 0);
    R.qTot.innerHTML = `<b>${items.length} video</b>` + (T.pend ? ` · in attesa ${T.pend}: ${fmtMB(T.inMB)} → ${st.settings.sceneQ ? '≤' : '≈'} ${T.unknown === T.pend ? '…' : fmtMB(T.mb)} MB · ≈ ${fmtTime(T.t)}` : '') + (S.length ? ` · fatti ${S.length}: ${fmtMB(doneIn)} → ${fmtMB(doneOut)} MB` : '');
    const miss = items.filter(needsFile).length;
    R.qRelinkBox.hidden = !miss; R.qRelinkTxt.textContent = `Riseleziona i video (${miss})`;
    R.qClear.hidden = !!q.running;
    if (st.qCur) { // video aggiunti o rimossi durante il lavoro: «Video n di N» aggiornato
      const i = items.findIndex((x) => x.id === st.qCur.id);
      if (i >= 0) { st.qCur.idx = i + 1; st.qCur.n = items.length; R.qNow.innerHTML = `Video <b>${st.qCur.idx}</b> di <b>${st.qCur.n}</b>`; const c = R.summary.querySelector('[data-qchip]'); if (c) c.textContent = `${st.qCur.idx}/${st.qCur.n}`; }
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
  R.qStop.addEventListener('click', () => { R.qStop.disabled = true; R.qStop.textContent = 'Mi fermo…'; R.cancel.disabled = true; handlers.onQueueStop?.(); });
  R.qSaveAll.addEventListener('click', () => handlers.onQueueSaveAll?.()); // sincrono: share sheet con tutti i file
  function renderQueueDone() {
    const items = st.queue?.items || [], S = items.filter((it) => it.status === 'fatto' && it.result);
    const inMB = S.reduce((a, it) => a + it.result.inMB, 0), outMB = S.reduce((a, it) => a + it.result.outMB, 0), tS = S.reduce((a, it) => a + (it.result.timeS || 0), 0);
    const pMB = S.reduce((a, it) => a + (it.result.predMB || 0), 0), pS = S.reduce((a, it) => a + (it.result.predS || 0), 0);
    const err = items.filter((it) => it.status === 'errore').length, pct = inMB ? (1 - outMB / inMB) * 100 : 0;
    R.qdTitle.textContent = err ? (S.length ? 'Coda finita, ma…' : 'Coda finita con errori') : 'Coda finita!';
    R.qdBig.textContent = S.length ? `${pct >= 0 ? '−' : '+'}${nf0.format(Math.abs(pct))}%` : '—'; R.qdBig.classList.toggle('neg', pct < 0);
    R.qdSub.textContent = S.length ? `${S.length} video · ${fmtMB(inMB)} → ${fmtMB(outMB)} MB${err ? ` · ${err} con errore` : ''}` : `${err} video con errore`;
    R.qdBody.innerHTML = items.map((it) => {
      const r = it.result, nm = `<th scope="row"><span class="fcv-qd-name">${esc(it.name)}</span>`;
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
    R.resumeText.textContent = `Trovato un export interrotto di questo video (${s.bitrateMbps} Mbps${s.sceneQ ? ' max, qualità per scena' : ''}${s.downscale ? ', 1080p' : ''}, key ${s.keyframeS}s): ${st.resume.done} segmenti su ${st.resume.total} già pronti.`;
    R.resumeBtn.textContent = `Riprendi export di ${st.resume.name} (segmenti ${st.resume.done}/${st.resume.total})`;
  }
  R.again.addEventListener('click', () => { setStage('ready'); root.querySelector('.fcv-step-set').scrollIntoView({ block: 'start' }); });
  R.cancel.addEventListener('click', () => {
    st.cancelling = true; R.cancel.disabled = true; R.cancel.textContent = 'Annullo…';
    handlers.onCancel?.();
  });

  // ---------- avanzamento ----------
  function startProgress({ keepLog = false } = {}) {
    st.predMB = predictMB(); st.predT = predictTime()?.s; st.vt0 = st.vt1 = st.vtEnd = 0; st.lastElapsed = 0; R.tline.hidden = true; st.par2Used = st.settings.par2; st.sceneUsed = st.settings.sceneQ; st.dsUsed = st.settings.downscale; st.phase = null; st.overall = 0; st.lastPct = -1; st.result = null; st.t0 = performance.now();
    if (!keepLog) clearLog();
    const s = st.settings;
    R.qNow.hidden = !st.qCur;
    if (st.qCur) R.qNow.innerHTML = `Video <b>${st.qCur.idx}</b> di <b>${st.qCur.n}</b>`;
    R.summary.innerHTML = `<span class="px-chip px-chip--num">${esc(st.file?.name || 'video')}</span><span class="px-chip px-chip--num">${s.sceneQ ? `per scena ≤ ${s.bitrateMbps}` : s.bitrateMbps} Mbps</span><span class="px-chip px-chip--num">key ${s.keyframeS}s</span>${s.downscale ? '<span class="px-chip px-chip--num">1080p</span>' : ''}<span class="px-chip">${esc(AUDIO_SHORT[s.audioMode] || s.audioMode)}</span>`;
    ['eta', 'fps', 'frames'].forEach((k) => { R[k].textContent = '—'; });
    R.elapsed.textContent = '0:00';
    R.progNote.textContent = KEEP_OPEN; R.progNote.dataset.kind = ''; st.pipOn = false; R.pipBox.hidden = true;
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
    if (show && sa) R.pipNote.textContent = 'Per lavorare in background apri il sito in Safari (nell\'app installata la finestrella PiP non funziona).';
    else R.pipNote.textContent = st.pipOn ? 'Finestrella aperta: puoi usare altre app, la compressione continua finché resta aperta.' : 'Puoi usare altre app: la compressione continua finché la finestrella resta aperta.';
    R.pipBtn.textContent = st.pipOn ? 'Chiudi Picture-in-Picture' : 'Continua in Picture-in-Picture';
  }
  // v0.35.3: dall'app installata, tasto «Apri in Safari» (lì funziona la PiP). iOS: schema x-safari-https:// (apre Safari);
  // se dopo ~1 s la pagina è ancora visibile, ripiego: link copiato negli appunti da incollare in Safari.
  if (standalone()) {
    R.safariBox.hidden = false;
    R.safariBtn.addEventListener('click', () => {
      const url = location.href.split('#')[0];
      try { location.href = 'x-safari-' + url; } catch {}
      setTimeout(() => {
        if (document.visibilityState !== 'visible') return;
        const ok = () => { R.safariMsg.textContent = 'Link copiato: aprilo incollandolo in Safari. (Nota: un export interrotto qui non si riprende in Safari, i dati sono separati.)'; };
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
    if (st.predT > 0) { R.tline.hidden = false; R.tline.textContent = `Previsto ${fmtTime(st.predT)} · trascorso ${fmtTime(elapsed)} · residuo ${fmtTime(eta)}`; }
    if (Number.isFinite(d.fps)) R.fps.innerHTML = `${nf0.format(d.fps)}<small>fps</small>`;
    if (p === 'video' && d.total) R.frames.innerHTML = `${nf0.format(d.done)}<small>/${nf0.format(d.total)}</small>`;
  }

  // ---------- risultato ----------
  function showResult(r) {
    if (pendingProg) { const x = pendingProg; pendingProg = null; applyProgress(x); } // ultimo avanzamento ancora in coda
    st.result = r;
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
    if (st.vFrames > 0 && vs > 1 && !st.sceneUsed) saveSpeed({ par2: st.par2Used, width: st.file?.width, height: st.file?.height, downscale: st.dsUsed }, st.vFrames / vs, realT);
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

  // ---------- bus ----------
  const subs = {
    file: (d) => { st.file = { ...st.file, ...d }; showFile(st.file); updateEstimate(); if (st.stage === 'pick') setStage('ready'); },
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
    /** PiP (v0.21): {active} → etichetta del pulsante «Continua / Chiudi Picture-in-Picture». */
    setPip(active) { st.pipOn = !!active; updatePip(); },
    setDefaults(s = {}) { Object.assign(DEFAULTS, s); writeSettings({ ...readSettings(), ...s }); },
    // --- estensioni ---
    getSettings: () => readSettings(),
    /** Offerta di ripresa per il file scelto: {name, done, total, settings} oppure null (nasconde). */
    setResume,
    /** Messaggio nel pannello di avanzamento (default «Tieni l'app aperta…»); kind '' | 'warn' | 'bad'. Testo vuoto = default. */
    setProgNote(text, kind = '') { R.progNote.textContent = text || KEEP_OPEN; R.progNote.dataset.kind = text ? kind : ''; },
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
      if (st.qMode) { st.file = null; setResume(null); R.pick.hidden = true; R.fileBox.hidden = true; R.queue.hidden = false; if (st.stage === 'pick' || st.stage === 'done' || st.stage === 'error') setStage('ready'); }
      else { st.queue = null; st.qCur = null; R.queue.hidden = true; R.pick.hidden = false; R.fileBox.hidden = true; R.qNow.hidden = true; if (!st.busy) setStage('pick'); }
      resetCancel(); syncSettings();
    },
    /** Vista della coda dall'app: {running, curId, msg:{text,kind}|null, items:[{id,name,sizeMB,status,info,result,error,saved,hasFile,hasOut,interrupted,lost,resume}]}. */
    setQueue(v) { st.queue = v || null; if (v) renderQueue(); },
    /** Inizio della coda (dopo setBusy(true)): log già azzerato, nessuna voce corrente. */
    queueStart() { st.qCur = null; st.qFirstIdx = null; st.qShareFb = false; resetCancel(); },
    /** Inizio di una voce: {id, idx, n, name, sizeMB, durationS?, width?, height?, fps?, …} → pannello di avanzamento azzerato (il log resta). */
    queueItemStart(m) {
      if (st.qFirstIdx == null) st.qFirstIdx = m.idx;
      st.qCur = m; st.file = { ...m }; st.cancelling = false; resetCancel();
      st.settings = readSettings(); startProgress({ keepLog: true });
      R.summary.insertAdjacentHTML('afterbegin', `<span class="px-chip px-chip--num" data-qchip>${m.idx}/${m.n}</span>`);
    },
    /** Voce finita: impara la velocità per le previsioni successive. */
    queueItemDone(id, r) { if (pendingProg) { const x = pendingProg; pendingProg = null; applyProgress(x); } learnSpeed(r?.timeS || st.lastElapsed); st.qCur = null; },
    /** Fine coda: schermata «Coda finita!» con tabella e «Salva tutti nelle Foto». */
    showQueueDone() { st.qCur = null; setStage('done'); renderQueueDone(); R.qdone.removeAttribute('data-pop'); void R.qdone.offsetWidth; R.qdone.setAttribute('data-pop', ''); if (!matchMedia('(prefers-reduced-motion: reduce)').matches && /^−/.test(R.qdBig.textContent)) confetti(R.qConfetti); R.qdone.scrollIntoView?.({ block: 'start' }); },
    /** «Salva tutti» non riuscito: un tasto per file nella schermata finale. */
    setQueueShareFallback(on) { st.qShareFb = !!on; renderQueue(); if (st.stage === 'done') renderQueueDone(); R.qdMsg.textContent = on ? 'Salvataggio insieme non riuscito: salva un video alla volta con i tasti qui sotto.' : ''; },
    /** Applica impostazioni (es. quelle salvate con la coda). */
    applySettings(s = {}) { writeSettings({ ...readSettings(), ...s }); },
    /** Torna al passo 1 (nessun file). */
    reset() { st.file = null; setResume(null); st.qMode = false; st.queue = null; root.dataset.queue = 'false'; R.queue.hidden = true; R.pick.hidden = false; R.fileBox.hidden = true; setBusy(false); setStage('pick'); updateEstimate(); },
    destroy() { for (const [t, h] of dndTargets) window.removeEventListener(t, h); listeners.forEach(([t, h]) => bus.removeEventListener(t, h)); root.innerHTML = ''; },
  };
}
