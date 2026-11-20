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
export function estimateOutBytes({ durS, videoMbps, audioMode = 'copy', aacBps }) {
  if (!(durS > 0)) return 0;
  return (videoMbps * 1e6 * VIDEO_OVERSHOOT + outAudioBps(audioMode, aacBps)) * durS / 8 * CONTAINER_OVERHEAD;
}
