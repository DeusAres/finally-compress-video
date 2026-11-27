// Stima del peso in uscita (usata dalla stima prima dell'avvio, dal controllo spazio e dal confronto finale previsto/reale).
//
//   bytes = ( videoMbps·1e6 × 1.03  +  audioBps ) × durata / 8 × 1.002
//
//  - 1.03  : sforamento medio dell'encoder HEVC hardware sul bitrate richiesto (solo video).
//  - audioBps: traccia audio effettivamente scritta. Modalità «copia»: bitrate medio della traccia AAC sorgente;
//              ricodifica (eco / audio ricodificato): AAC 256 kbps. Nessuna traccia AAC → 0.
//              Se il bitrate sorgente non è noto (info non ancora letta) si assume 256 kbps.
//  - 1.002 : ~0.2 % di overhead del contenitore MP4 (tabelle campioni, moov, metadati).
export const VIDEO_OVERSHOOT = 1.03, CONTAINER_OVERHEAD = 1.002, REENC_AUDIO_BPS = 256000;

/** Bitrate audio (bit/s) della traccia in uscita. aacBps: bitrate AAC sorgente (0 = nessuna traccia AAC, undefined = ignoto). */
export function outAudioBps(audioMode, aacBps) {
  if (aacBps === 0) return 0;
  if (audioMode === 'copy') return aacBps > 0 ? aacBps : REENC_AUDIO_BPS;
  return REENC_AUDIO_BPS;
}

/** Peso stimato del file finale in byte. */
/** pixelRatio (v0.38, SDR con risoluzione ridotta): pixel scelti / pixel sorgente, scala la parte video del peso (1 = risoluzione originale). */
export function estimateOutBytes({ durS, videoMbps, audioMode = 'copy', aacBps, apacBps = 0, pixelRatio = 1 }) {
  if (!(durS > 0)) return 0;
  const spatial = audioMode === 'copy' && aacBps !== 0 && apacBps > 0 ? apacBps : 0; // traccia apac copiata (v0.32): solo con l'AAC copiato
  return (videoMbps * (pixelRatio > 0 ? Math.min(1, pixelRatio) : 1) * 1e6 * VIDEO_OVERSHOOT + outAudioBps(audioMode, aacBps) + spatial) * durS / 8 * CONTAINER_OVERHEAD;
}

// ---------- Stima del TEMPO ----------
//   t = 0.5 s (analisi) + frame / fpsAtteso + 3 % · tVideo + 0.5 s (assemblaggio, audio, scrittura) [+ 0.07 s · durata se eco v4]
// fpsAtteso: ultima misura reale (localStorage, per 1/2 player e ≤1080p/4K); in mancanza, un default.
export const DEFAULT_FPS = { p3: { hd: 110, uhd: 80 }, p2: { hd: 90, uhd: 70 }, p1: { hd: 57, uhd: 55 } }; // p3 (v0.37, sperimentale): stima da rimisurare
// downscale (v0.31 «Riduci a 1080p»): l'estrazione resta quella del 4K (stessa classe uhd) ma la velocità si salva a parte (l'encoder scala: costo diverso)
// SDR (v0.38, VideoDecoder → WebGPU → HEVC 8 bit, nessun <video> di seek): classe «sdr» indipendente dai player. hd misurato su iPhone
// (sdr8 v2.1, 1080p60: 250 fps, limite l'encoder); uhd e uhd ridotto sono IPOTESI (decoder 4K ~4× più lento, encoder 4K ~¼), da rimisurare.
export const DEFAULT_SDR_FPS = { hd: 250, uhd: 70, 'uhd.ds': 160 };
// HDR veloce 8 bit ('hdr8'): frame del decoder diretti all'encoder; hd misurato su iPhone (sdr8 c_hlg8: 257 fps), uhd IPOTESI come SDR
export const DEFAULT_HDR8_FPS = { hd: 257, uhd: 70, 'uhd.ds': 160 };
const fastMode = (m) => m === 'sdr' || m === 'hdr8';
export const speedKey = ({ par2, width, height, downscale, mode }) => `fcv.fps.${fastMode(mode) ? mode : par2 === 3 ? 'p3' : par2 ? 'p2' : 'p1'}.${Math.max(width || 0, height || 0) > 1920 ? 'uhd' : 'hd'}${downscale ? '.ds' : ''}`;

/** Velocità attesa {fps, measured}. */
export function expectedFps(o) {
  try { const v = +localStorage.getItem(speedKey(o)); if (v > 1 && isFinite(v)) return { fps: v, measured: true }; } catch {}
  const k = speedKey(o).split('.');
  if (fastMode(k[2])) { const c = k[3] === 'hd' ? 'hd' : k[4] ? 'uhd.ds' : 'uhd'; return { fps: (k[2] === 'sdr' ? DEFAULT_SDR_FPS : DEFAULT_HDR8_FPS)[c], measured: false, guess: c !== 'hd' }; }
  return { fps: DEFAULT_FPS[k[2]][k[3]], measured: false };
}
/** Salva la velocità reale (frame/s della fase video) e il tempo totale dell'ultimo job. */
export function saveSpeed(o, fps, totalS) {
  try { if (fps > 1 && isFinite(fps)) localStorage.setItem(speedKey(o), String(fps)); if (totalS > 0) localStorage.setItem('fcv.lastTotalS', String(totalS)); } catch {}
}
// «Qualità garantita per scena»: tempo totale = tempo della sola codifica × fattore. v0.32 misurato 2× (codifica a 1 player);
// v0.34.1 su IMG_3053 prove 8.8 s + codifica 4.2 s (2 player) ≈ 3×. v0.35 (prove più veloci, research/12 §12): stima ≈ 1.6×, da
// rimisurare sul device con la riga «prove: tempi …» del log. Tenere uguale a scenesearch.SCENE.timeFactor.
export const SCENE_TIME_FACTOR = 1.6;
/** Tempo totale previsto in secondi + fonte della velocità. sceneQ: tempo del video × SCENE_TIME_FACTOR (variabile). */
// mode 'sdr' / 'hdr8': velocità della propria classe, qualità per scena ignorata (disattivata in SDR); downscale = qualunque riduzione (settings.res).
export function estimateTimeS({ durS, fps = 30, audioMode = 'copy', par2, width, height, sceneQ = false, downscale = false, mode = 'hdr', res = null }) {
  if (!(durS > 0)) return null;
  const sdr = fastMode(mode), ds = sdr ? !!downscale || (res != null && res !== 'orig' && +res > 0 && +res < Math.min(width || 0, height || 0)) : downscale;
  if (sdr) sceneQ = false;
  const frames = durS * (fps > 0 ? fps : 30), sp = expectedFps({ par2, width, height, downscale: ds, mode });
  const tv = frames / sp.fps * (sceneQ ? SCENE_TIME_FACTOR : 1);
  return { s: 0.5 + tv * 1.03 + 0.5 + (audioMode === 'v4' ? 0.07 * durS : 0), measured: sp.measured, fps: sp.fps, variable: !!sceneQ, guess: !!sp.guess };
}
