// Diagnostica delle risorse media (v0.36.2): quanti <video>/<audio> esistono (anche FUORI dal DOM), quanti hanno ancora una
// sorgente (su iOS un <video> con src occupa un player/decoder anche in pausa), quanti sono in riproduzione, e quanti
// VideoEncoder/VideoDecoder/AudioEncoder/AudioDecoder sono aperti. Serve a vedere sul device se qualcosa cresce fra le voci
// della coda. Solo conteggi: riferimenti DEBOLI (WeakRef), nessun elemento/codec trattenuto, nessun comportamento cambiato.
// install() avvolge document.createElement('video'|'audio'), new Audio() e i costruttori WebCodecs (Proxy trasparente).

const media = [], codecs = { VideoEncoder: [], VideoDecoder: [], AudioEncoder: [], AudioDecoder: [] }, made = { video: 0, audio: 0 };
let installed = false;
const seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
const prune = (a) => { for (let i = a.length - 1; i >= 0; i--) if (!a[i].deref()) a.splice(i, 1); };
function addMedia(e) {
  if (!e || !seen || seen.has(e)) return; seen.add(e);
  media.push(new WeakRef(e)); made[e.tagName === 'VIDEO' ? 'video' : 'audio']++;
  if (media.length > 64) prune(media);
}

export function installMediaDiag() {
  if (installed || typeof window === 'undefined' || typeof WeakRef === 'undefined') return; installed = true;
  try {
    const ce = Document.prototype.createElement;
    Document.prototype.createElement = function (n, o) { const e = ce.call(this, n, o); if (typeof n === 'string' && /^(video|audio)$/i.test(n)) addMedia(e); return e; };
  } catch {}
  try { const A0 = window.Audio; if (A0) window.Audio = new Proxy(A0, { construct(t, a, nt) { const e = Reflect.construct(t, a, nt); addMedia(e); return e; } }); } catch {}
  // elementi nati da HTML (innerHTML/parser): li vede il primo 'loadstart'
  try { document.addEventListener('loadstart', (e) => { if (e.target instanceof HTMLMediaElement) addMedia(e.target); }, true); } catch {}
  for (const k of Object.keys(codecs)) {
    const B = window[k]; if (typeof B !== 'function') continue;
    try { window[k] = new Proxy(B, { construct(t, a, nt) { const x = Reflect.construct(t, a, nt); codecs[k].push(new WeakRef(x)); if (codecs[k].length > 64) prune(codecs[k]); return x; } }); } catch {}
  }
}

// currentSrc da solo non basta: dopo removeAttribute('src') + load() resta valorizzato (Chromium) anche con networkState EMPTY
const hasSrc = (m) => !!(m.getAttribute('src') || m.srcObject || (m.currentSrc && m.networkState !== 0));
/** Conteggi correnti (elementi raccolti dal GC esclusi). */
export function mediaDiag() {
  const els = media.map((w) => w.deref()).filter(Boolean), vids = els.filter((m) => m.tagName === 'VIDEO'), auds = els.filter((m) => m.tagName !== 'VIDEO');
  const open = (k) => codecs[k].map((w) => w.deref()).filter((x) => x && x.state !== 'closed').length;
  return {
    vAlive: vids.length, vMade: made.video, vSrc: vids.filter(hasSrc).length, vDom: vids.filter((m) => m.isConnected).length,
    vOutSrc: vids.filter((m) => !m.isConnected && hasSrc(m)).length, vPlay: vids.filter((m) => !m.paused && hasSrc(m)).length,
    aAlive: auds.length, aSrc: auds.filter(hasSrc).length, aPlay: auds.filter((m) => !m.paused && hasSrc(m)).length,
    venc: open('VideoEncoder'), vdec: open('VideoDecoder'), aenc: open('AudioEncoder'), adec: open('AudioDecoder'),
  };
}
/** Riga per il log: «risorse: <fase> · <video> …». */
export function mediaDiagLine(when, extra = '') {
  const d = mediaDiag();
  return `risorse: ${when} · <video> con src ${d.vSrc} (nel DOM ${d.vDom}, fuori ${d.vOutSrc}), in riproduzione ${d.vPlay}, vivi ${d.vAlive}/${d.vMade} creati` +
    ` · <audio> con src ${d.aSrc}, in riproduzione ${d.aPlay} · aperti: VideoEncoder ${d.venc}, VideoDecoder ${d.vdec}, AudioEncoder ${d.aenc}, AudioDecoder ${d.adec}${extra ? ' · ' + extra : ''}`;
}
