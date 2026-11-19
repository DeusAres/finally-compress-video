// UI pixel art di finally-compress-video. Contratto: app/ui/README.md.
// mountUI(root, handlers) → { setBusy, setDefaults, getSettings, setSaveMessage, reset }
import { bus } from './bus.js?v=0.18';
import { sprite, SPRITES } from './sprite.js?v=0.18';

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
const DEFAULTS = { bitrateMbps: 8, keyframeS: 4, audioMode: 'copy', bgAudio: false };

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
    const href = new URL(name, import.meta.url).href;
    if (![...document.styleSheets].some((s) => s.href === href) && !document.querySelector(`link[href="${href}"]`)) {
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
    }
  }
}

function template(opts) {
  const s = (k, o) => sprite(SPRITES[k], o);
  const brSeg = BITRATES.map((b) => `<label><input type="radio" name="fcv-br" value="${b}"><span>${b}${b === 8 ? `<i class="star">${s('star', { scale: 2 })}</i>` : '<small>Mbps</small>'}</span></label>`).join('');
  const kfSeg = KEYFRAMES.map((k) => `<label><input type="radio" name="fcv-kf" value="${k}"><span>${k}<small>sec</small></span></label>`).join('');
  const audio = AUDIO.map((a) => `<label class="fcv-radio"${a.dev ? ' data-dev' : ''}><input type="radio" name="fcv-audio" value="${a.v}"><div><b>${a.b}</b><span>${a.t}</span></div></label>`).join('');
  const chain = PHASES.map((p) => `<li data-p="${p.id}">${s(p.icon || p.id, { scale: 2 })}${p.label}</li>`).join('');
  return `
<header class="fcv-head">
  ${s('logo', { scale: 4, className: 'fcv-logo px-bob', title: 'Logo' })}
  <div>
    <h1 class="px-title">Finally <b>Compress</b><span class="fcv-cursor px-blink"></span></h1>
    <p>Video HDR e Dolby Vision dell'iPhone, più leggeri. Tutto resta sul telefono.${opts.version ? ` <span class="px-chip px-chip--num">${esc(opts.version)}</span>` : ''}</p>
  </div>
</header>

<ol class="fcv-steps" aria-label="Passi">
  <li data-step="1"><span class="n">1</span>Scegli</li>
  <li data-step="2"><span class="n">2</span>Regola</li>
  <li data-step="3"><span class="n">3</span>Comprimi</li>
</ol>

<div class="fcv-drop" data-ref="drop" hidden aria-hidden="true">${s('film', { scale: 8, className: 'px-bob' })}<b class="px-title">Rilascia qui il video</b><span>Solo il primo file video</span></div>

<section class="px-panel fcv-card fcv-step-file" aria-labelledby="fcv-h1">
  <header><span class="num">1</span><h2 class="px-title" id="fcv-h1">Scegli il video</h2></header>
  <label class="fcv-pick" data-ref="pick">
    <input type="file" accept="video/*,.mov,.mp4" data-ref="input" aria-label="Scegli un video">
    ${s('film', { scale: 7, className: 'px-bob' })}
    <span class="fcv-pick-cta">Tocca per scegliere</span>
    <small>Dalla Libreria Foto o da File. Nessun caricamento: il video non lascia l'iPhone.</small>
  </label>
  <p class="fcv-drop-msg" data-ref="dropMsg" role="status" aria-live="polite" hidden></p>
  <div class="fcv-file" data-ref="fileBox" hidden>
    <div class="fcv-file-name">${s('film', { scale: 4 })}<div><strong data-ref="fName"></strong><div class="fcv-chips" data-ref="fChips"></div></div></div>
    <div class="fcv-stats">
      <div class="fcv-stat"><span class="px-label">Peso</span><span class="v px-digits" data-ref="fSize">—</span></div>
      <div class="fcv-stat"><span class="px-label">Durata</span><span class="v px-digits" data-ref="fDur">—</span></div>
      <div class="fcv-stat"><span class="px-label">Formato</span><span class="v px-digits" data-ref="fRes">—</span></div>
    </div>
    <div class="fcv-file-actions"><label class="px-btn fcv-relabel" data-ref="change">Cambia video<input type="file" accept="video/*,.mov,.mp4" data-ref="input2" aria-label="Cambia video"></label></div>
  </div>
</section>

<section class="px-panel fcv-card fcv-step-set" aria-labelledby="fcv-h2">
  <header><span class="num">2</span><h2 class="px-title" id="fcv-h2">Regola la qualità</h2></header>
  <fieldset class="fcv-field">
    <legend class="px-label">Bitrate video · Mbps</legend>
    <div class="px-seg fcv-seg-br" data-ref="br">${brSeg}</div>
    <p class="fcv-hint" data-ref="brHint" aria-live="polite"></p>
  </fieldset>
  <div class="fcv-meters">
    <div class="fcv-meter"><span class="px-label">Qualità</span><div class="fcv-hearts" data-ref="hearts"></div></div>
    <div class="fcv-meter"><span class="px-label">Peso stimato</span><div class="fcv-est px-digits" data-ref="est">—</div></div>
  </div>
  <p class="fcv-warn" data-ref="warn" hidden></p>
  <details class="fcv-adv">
    <summary>${s('chevron', { scale: 2, className: 'chev' })}Opzioni avanzate<span class="px-chip px-chip--num" data-ref="advSum"></span></summary>
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
    <fieldset class="fcv-field">
      <legend class="px-label">Sperimentale</legend>
      <label class="fcv-radio"><input type="checkbox" name="fcv-bgaudio" value="1"><div><b>Test background con audio</b><span>Riproduce un audio quasi muto per provare a far continuare la compressione con l'app in background (controlli «In riproduzione»). Il log registra un battito al secondo e un riepilogo finale.</span></div></label>
    </fieldset>
  </details>
</section>

<section class="px-panel fcv-card fcv-step-go" aria-labelledby="fcv-h3">
  <header><span class="num">3</span><h2 class="px-title" id="fcv-h3">Comprimi</h2></header>
  <button class="px-btn px-btn--primary px-btn--xl px-btn--block fcv-go" data-ref="go" disabled>Comprimi ${sprite(['c...', 'cc..', 'ccc.', 'cccc', 'ccc.', 'cc..', 'c...'], { scale: 4 })}</button>
  <p class="fcv-go-note" data-ref="goNote">Scegli prima un video.</p>
  <div class="fcv-resume" data-ref="resume" hidden>
    <p class="fcv-warn" data-ref="resumeText"></p>
    <button class="px-btn px-btn--ok px-btn--block" data-ref="resumeBtn">Riprendi export</button>
  </div>
</section>

<section class="px-panel fcv-prog" data-ref="prog" hidden aria-labelledby="fcv-hp">
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
  <p class="fcv-warn fcv-keep" data-ref="progNote" role="status" aria-live="polite">${KEEP_OPEN}</p>
  <button class="px-btn px-btn--danger fcv-cancel" data-ref="cancel">Annulla</button>
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
    <div class="fcv-cmp-row"><span class="px-label">Prima</span><div class="px-bar before" style="--p:1"><i></i></div><span class="v px-digits" data-ref="inMB"></span></div>
    <div class="fcv-cmp-row"><span class="px-label">Dopo</span><div class="px-bar" data-ref="afterBar"><i></i></div><span class="v px-digits" data-ref="outMB"></span></div>
  </div>
  <p class="fcv-freed" data-ref="freed"></p>
  <p class="fcv-pred" data-ref="pred" hidden></p>
  <p class="fcv-pred-note" data-ref="predNote" hidden></p>
  <button class="px-btn px-btn--ok px-btn--xl px-btn--block" data-ref="save">${s('scrittura', { scale: 3 })}Salva nelle Foto</button>
  <p class="fcv-save-msg" data-ref="saveMsg" aria-live="polite"></p>
  <p class="fcv-outname" data-ref="outName"></p>
  <div class="fcv-done-more">
    <button class="px-btn px-btn--ghost" data-ref="again">Prova altre impostazioni</button>
    <label class="px-btn px-btn--ghost fcv-relabel">Nuovo video<input type="file" accept="video/*,.mov,.mp4" data-ref="input3" aria-label="Scegli un nuovo video"></label>
  </div>
</section>

<section class="px-panel fcv-err" data-ref="err" hidden role="alert">
  <header>${s('errore', { scale: 4 })}<h2 class="px-title">Ops! Qualcosa si è inceppato</h2></header>
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
  <summary>${s('chevron', { scale: 2, className: 'chev' })}Log tecnico<span class="px-chip count" data-ref="logCount">0</span></summary>
  <pre data-ref="log" tabindex="0"></pre>
  <div class="fcv-log-actions"><button class="px-btn" data-ref="copy">Copia log</button><span class="fcv-copy-msg" data-ref="copyMsg" aria-live="polite"></span></div>
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
    R.done.hidden = stage !== 'done';
    R.err.hidden = stage !== 'error';
    const steps = { pick: ['now', '', ''], ready: ['done', 'now', ''], busy: ['done', 'done', 'now'], done: ['done', 'done', 'done'], error: ['done', 'done', 'now'] }[stage];
    root.querySelectorAll('.fcv-steps li').forEach((li, i) => {
      li.dataset.s = steps[i];
      li.querySelector('.n').innerHTML = steps[i] === 'done' ? sprite(SPRITES.check, { scale: 2 }) : String(i + 1);
      li.toggleAttribute('aria-current', steps[i] === 'now');
    });
    R.go.disabled = !st.file || st.busy;
    R.goNote.textContent = st.file ? 'Tieni Safari aperto e lo schermo acceso: la compressione avviene sul telefono.' : 'Scegli prima un video.';
  }
  function setBusy(b) {
    st.busy = !!b;
    root.dataset.busy = String(st.busy);
    root.querySelectorAll('.fcv-step-set input, [data-ref^="input"]').forEach((i) => { i.disabled = st.busy; });
    R.go.disabled = !st.file || st.busy;
    if (st.busy) {
      R.resume.hidden = true;
      if (st.stage !== 'busy') startProgress();
    } else if (st.stage === 'busy') {
      // finito senza 'result' né 'error' → annullato
      setStage(st.file ? 'ready' : 'pick');
      R.resume.hidden = !st.resume;
      if (st.cancelling) R.goNote.textContent = 'Compressione annullata.';
    }
    st.cancelling = false;
    R.cancel.disabled = false; R.cancel.textContent = 'Annulla';
  }

  // ---------- passo 1: file ----------
  function onPicked(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    acceptFile(f);
  }
  function acceptFile(f) {
    R.dropMsg.hidden = true; setResume(null);
    st.file = { name: f.name, sizeMB: f.size / 1048576 };
    showFile(st.file);
    R.log.textContent = ''; st.logLines = 0; R.logCount.textContent = '0';
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
    if (fi.width && fi.height) chips.push(`<span class="px-chip px-chip--num">${fi.width}×${fi.height}</span>`);
    if (fi.fps) chips.push(`<span class="px-chip px-chip--num">${Math.round(fi.fps)} fps</span>`);
    R.fChips.innerHTML = chips.join('');
    updateEstimate();
  }
  // ---------- drag & drop (pagina intera; iPad/iPhone: trascinamento da Foto in Split View / Slide Over) ----------
  const isVideo = (f) => /^video\//.test(f.type) || /\.(mov|mp4|m4v|hevc)$/i.test(f.name || '');
  const hasFiles = (e) => { const t = e.dataTransfer?.types; return !!t && [...t].includes('Files'); };
  let dragDepth = 0;
  const dropOn = (on) => { R.drop.hidden = !on; root.classList.toggle('fcv-dragging', on); };
  const dropMessage = (t) => { R.dropMsg.textContent = t; R.dropMsg.hidden = false; };
  const onDragEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (st.busy) return; dragDepth++; dropOn(true); };
  const onDragOver = (e) => { if (!hasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = st.busy ? 'none' : 'copy'; } catch {} };
  const onDragLeave = (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOn(false); };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dropOn(false);
    if (st.busy) { dropMessage('Compressione in corso: attendi la fine prima di cambiare video.'); return; }
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) for (const it of e.dataTransfer.items || []) { const f = it.kind === 'file' ? it.getAsFile() : null; if (f) files.push(f); }
    const v = files.find(isVideo);
    if (!v) { dropMessage(files.length ? 'Questo non è un video: trascina un file video (MOV, MP4).' : 'Nessun file ricevuto: prova col pulsante «Tocca per scegliere».'); return; }
    acceptFile(v);
    if (files.length > 1) dropMessage('Rilasciati più file: uso solo il primo video.');
  };
  const dndTargets = [['dragenter', onDragEnter], ['dragover', onDragOver], ['dragleave', onDragLeave], ['drop', onDrop]];
  for (const [t, h] of dndTargets) window.addEventListener(t, h);
  for (const k of ['input', 'input2', 'input3']) R[k].addEventListener('change', onPicked);

  // ---------- passo 2: impostazioni ----------
  function readSettings() {
    const v = (n) => root.querySelector(`input[name="${n}"]:checked`)?.value;
    return { bitrateMbps: +v('fcv-br') || DEFAULTS.bitrateMbps, keyframeS: +v('fcv-kf') || DEFAULTS.keyframeS, audioMode: v('fcv-audio') || DEFAULTS.audioMode, bgAudio: !!v('fcv-bgaudio') };
  }
  function writeSettings(s) {
    const set = (n, val) => { const i = root.querySelector(`input[name="${n}"][value="${val}"]`); if (i) i.checked = true; };
    set('fcv-br', s.bitrateMbps); set('fcv-kf', s.keyframeS); set('fcv-audio', s.audioMode);
    if (s.bgAudio != null) { const c = root.querySelector('input[name="fcv-bgaudio"]'); if (c) c.checked = !!s.bgAudio; }
    syncSettings();
  }
  function syncSettings() {
    st.settings = readSettings();
    const { bitrateMbps: br, keyframeS: kf, audioMode: am } = st.settings;
    const info = BR_INFO[br] || BR_INFO[8];
    R.brHint.textContent = info.t;
    R.hearts.innerHTML = Array.from({ length: 5 }, (_, i) => sprite(SPRITES[i < info.q ? 'heart' : 'heartEmpty'], { scale: 3 })).join('') + `<span class="px-sr">${info.q} su 5</span>`;
    R.kfHint.textContent = KF_INFO[kf] || '';
    R.advSum.textContent = `${kf}s · ${AUDIO_SHORT[am] || am}${st.settings.bgAudio ? ' · test bg' : ''}`;
    updateEstimate();
  }
  const predictMB = (br = st.settings.bitrateMbps, d = st.file?.durationS) => (d ? (br + 0.26) * d / 8 * (1e6 / 1048576) : null);
  function updateEstimate() {
    const d = st.file?.durationS, src = st.file?.sizeMB;
    R.warn.hidden = true;
    if (!d) { R.est.innerHTML = st.file ? '…' : '—'; return; }
    const est = predictMB();
    const pct = src ? (1 - est / src) * 100 : null;
    R.est.innerHTML = `≈${fmtMB(est)}<small style="font-size:18px">MB</small>` + (pct != null ? ` <span class="save ${pct <= 0 ? 'bad' : ''}">${pct > 0 ? '−' : '+'}${nf0.format(Math.abs(pct))}%</span>` : '');
    if (pct != null && pct < 10) {
      R.warn.hidden = false;
      R.warn.textContent = 'Questo video è già leggero: con questo bitrate il risparmio sarà minimo o nullo. Prova un valore più basso.';
    }
  }
  root.querySelector('.fcv-step-set').addEventListener('change', syncSettings);

  // ---------- passo 3: via ----------
  R.go.addEventListener('click', () => {
    if (!st.file || st.busy) return;
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
    R.resumeText.textContent = `Trovato un export interrotto di questo video (${s.bitrateMbps} Mbps, key ${s.keyframeS}s): ${st.resume.done} segmenti su ${st.resume.total} già pronti.`;
    R.resumeBtn.textContent = `Riprendi export di ${st.resume.name} (segmenti ${st.resume.done}/${st.resume.total})`;
  }
  R.again.addEventListener('click', () => { setStage('ready'); root.querySelector('.fcv-step-set').scrollIntoView({ block: 'start' }); });
  R.cancel.addEventListener('click', () => {
    st.cancelling = true; R.cancel.disabled = true; R.cancel.textContent = 'Annullo…';
    handlers.onCancel?.();
  });

  // ---------- avanzamento ----------
  function startProgress() {
    st.predMB = predictMB(); st.phase = null; st.overall = 0; st.lastPct = -1; st.result = null; st.t0 = performance.now();
    R.log.textContent = ''; st.logLines = 0; R.logCount.textContent = '0';
    const s = st.settings;
    R.summary.innerHTML = `<span class="px-chip px-chip--num">${esc(st.file?.name || 'video')}</span><span class="px-chip px-chip--num">${s.bitrateMbps} Mbps</span><span class="px-chip px-chip--num">key ${s.keyframeS}s</span><span class="px-chip">${esc(AUDIO_SHORT[s.audioMode] || s.audioMode)}</span>`;
    ['eta', 'fps', 'frames'].forEach((k) => { R[k].textContent = '—'; });
    R.elapsed.textContent = '0:00';
    R.progNote.textContent = KEEP_OPEN; R.progNote.dataset.kind = '';
    renderPct(0);
    setPhase('analisi');
    setStage('busy');
    root.dataset.busy = 'true';
    R.prog.scrollIntoView?.({ block: 'start' });
  }
  function setPhase(p) {
    if (st.phase === p) return;
    const idx = PHASES.findIndex((x) => x.id === p);
    if (idx < 0) return;
    // le fasi saltate contano come completate
    st.overall = Math.max(st.overall, PHASES.slice(0, idx).reduce((a, x) => a + WEIGHT[x.id], 0));
    st.phase = p;
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
    if (Number.isFinite(d.fps)) R.fps.innerHTML = `${nf0.format(d.fps)}<small>fps</small>`;
    if (p === 'video' && d.total) R.frames.innerHTML = `${nf0.format(d.done)}<small>/${nf0.format(d.total)}</small>`;
  }

  // ---------- risultato ----------
  function showResult(r) {
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
    R.freed.innerHTML = freed > 0 ? `Hai liberato <b>${fmtMB(freed)} MB</b> · ${nf1.format(r.inMB / r.outMB)}× più piccolo` : 'Il video originale era già molto compresso: prova un bitrate più basso.';
    R.pred.hidden = R.predNote.hidden = true;
    if (st.predMB > 0) {
      const dev = (r.outMB / st.predMB - 1) * 100, sign = dev > 0 ? '+' : dev < 0 ? '−' : '±';
      R.pred.textContent = `Previsto ≈ ${fmtMB(st.predMB)} MB · Reale ${fmtMB(r.outMB)} MB · scarto ${sign}${nf1.format(Math.abs(dev))} %`;
      R.pred.hidden = false;
      if (Math.abs(dev) > 15) { R.predNote.textContent = 'Scarto oltre il 15%: la previsione usa un bitrate medio fisso, ma scene molto semplici o molto movimentate pesano diversamente.'; R.predNote.hidden = false; }
      appendLog(`PREVISIONE: previsto ≈ ${st.predMB.toFixed(2)} MB · reale ${r.outMB.toFixed(2)} MB · scarto ${dev > 0 ? '+' : ''}${dev.toFixed(1)} %`);
    }
    R.outName.textContent = r.fileName || '';
    R.saveMsg.textContent = '';
    setStage('done');
    R.done.removeAttribute('data-pop'); void R.done.offsetWidth; R.done.setAttribute('data-pop', '');
    if (saved > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches) confetti();
    R.done.scrollIntoView?.({ block: 'start' });
  }
  function confetti() {
    const cols = ['--px-yellow', '--px-lime', '--px-sky', '--px-orange', '--px-red', '--px-cyan'];
    R.confetti.innerHTML = Array.from({ length: 22 }, (_, i) => {
      const x = (i * 37) % 100, dx = ((i * 53) % 80) - 40, delay = (i % 7) * 70;
      return `<i style="left:${x}%;--dx:${dx}px;background:var(${cols[i % cols.length]});animation-delay:${delay}ms"></i>`;
    }).join('');
    setTimeout(() => { R.confetti.innerHTML = ''; }, 2400);
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
  function appendLog(line) {
    R.log.append(document.createTextNode((st.logLines ? '\n' : '') + line));
    st.logLines++;
    R.logCount.textContent = String(st.logLines);
    if (R.logBox.open) R.log.scrollTop = R.log.scrollHeight;
  }
  function copyLog() {
    if (handlers.onCopyLog) { handlers.onCopyLog(); return; }
    const t = R.log.textContent;
    const fallback = () => { getSelection().selectAllChildren(R.log); setSaveCopyMsg('Testo selezionato: tocca Copia'); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(() => setSaveCopyMsg('Copiato!'), fallback); else fallback();
  }
  function setSaveCopyMsg(t) { R.copyMsg.textContent = t; clearTimeout(st.copyT); st.copyT = setTimeout(() => { R.copyMsg.textContent = ''; }, 3000); }
  R.copy.addEventListener('click', copyLog);
  R.errCopy.addEventListener('click', () => { R.logBox.open = true; copyLog(); });

  // ---------- bus ----------
  const subs = {
    file: (d) => { st.file = { ...st.file, ...d }; showFile(st.file); if (st.stage === 'pick') setStage('ready'); },
    phase: (d) => {
      if (d.phase === 'errore') { if (st.stage !== 'error') showError(st.lastError || 'La compressione si è interrotta.'); return; }
      if (d.phase === 'fatto') { renderPct(1); return; }
      if (st.stage !== 'busy') startProgress();
      setPhase(d.phase);
    },
    progress: onProgress,
    result: showResult,
    log: (d) => appendLog(d.line ?? ''),
    error: (d) => { st.lastError = d.message; showError(d.message); },
  };
  const listeners = Object.entries(subs).map(([t, fn]) => { const h = (e) => fn(e.detail || {}); bus.addEventListener(t, h); return [t, h]; });

  writeSettings(DEFAULTS);
  setStage('pick');
  root.dataset.busy = 'false';

  return {
    setBusy,
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
    /** Testo completo del log mostrato. */
    getLog: () => R.log.textContent,
    /** Torna al passo 1 (nessun file). */
    reset() { st.file = null; setResume(null); R.pick.hidden = false; R.fileBox.hidden = true; setBusy(false); setStage('pick'); updateEstimate(); },
    destroy() { for (const [t, h] of dndTargets) window.removeEventListener(t, h); listeners.forEach(([t, h]) => bus.removeEventListener(t, h)); root.innerHTML = ''; },
  };
}
