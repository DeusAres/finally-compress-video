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
export function estimateOutBytes({ durS, videoMbps, audioMode = 'copy', aacBps, apacBps = 0 }) {
  if (!(durS > 0)) return 0;
  const spatial = audioMode === 'copy' && aacBps !== 0 && apacBps > 0 ? apacBps : 0; // traccia apac copiata (v0.32): solo con l'AAC copiato
  return (videoMbps * 1e6 * VIDEO_OVERSHOOT + outAudioBps(audioMode, aacBps) + spatial) * durS / 8 * CONTAINER_OVERHEAD;
}

// ---------- Stima del TEMPO ----------
//   t = 0.5 s (analisi) + frame / fpsAtteso + 3 % · tVideo + 0.5 s (assemblaggio, audio, scrittura) [+ 0.07 s · durata se eco v4]
// fpsAtteso: ultima misura reale (localStorage, per 1/2 player e ≤1080p/4K); in mancanza, un default.
export const DEFAULT_FPS = { p2: { hd: 90, uhd: 70 }, p1: { hd: 57, uhd: 55 } };
// downscale (v0.31 «Riduci a 1080p»): l'estrazione resta quella del 4K (stessa classe uhd) ma la velocità si salva a parte (l'encoder scala: costo diverso)
export const speedKey = ({ par2, width, height, downscale }) => `fcv.fps.${par2 ? 'p2' : 'p1'}.${Math.max(width || 0, height || 0) > 1920 ? 'uhd' : 'hd'}${downscale ? '.ds' : ''}`;

/** Velocità attesa {fps, measured}. */
export function expectedFps(o) {
  try { const v = +localStorage.getItem(speedKey(o)); if (v > 1 && isFinite(v)) return { fps: v, measured: true }; } catch {}
  const k = speedKey(o).split('.');
  return { fps: DEFAULT_FPS[k[2]][k[3]], measured: false };
}
/** Salva la velocità reale (frame/s della fase video) e il tempo totale dell'ultimo job. */
export function saveSpeed(o, fps, totalS) {
  try { if (fps > 1 && isFinite(fps)) localStorage.setItem(speedKey(o), String(fps)); if (totalS > 0) localStorage.setItem('fcv.lastTotalS', String(totalS)); } catch {}
}
// «Qualità garantita per scena» (v0.28): le prove per segmento portano il tempo a ≈ 1.7× (research/12 §6, stima da misurare su iPhone).
export const SCENE_TIME_FACTOR = 1.7;
/** Tempo totale previsto in secondi + fonte della velocità. sceneQ: tempo del video × SCENE_TIME_FACTOR (variabile). */
export function estimateTimeS({ durS, fps = 30, audioMode = 'copy', par2, width, height, sceneQ = false, downscale = false }) {
  if (!(durS > 0)) return null;
  const frames = durS * (fps > 0 ? fps : 30), sp = expectedFps({ par2, width, height, downscale });
  const tv = frames / sp.fps * (sceneQ ? SCENE_TIME_FACTOR : 1);
  return { s: 0.5 + tv * 1.03 + 0.5 + (audioMode === 'v4' ? 0.07 * durS : 0), measured: sp.measured, fps: sp.fps, variable: !!sceneQ };
}
