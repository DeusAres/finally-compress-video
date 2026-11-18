# BIBBIA — Progetto "finally-compress-video"

> Documento di riferimento e taccuino di lavoro. È la fonte di verità del progetto:
> prima di qualsiasi decisione tecnica si consulta e si aggiorna questo file,
> non la memoria della conversazione.
>
> Legenda affidabilità: ✅ verificato (fonte primaria o misura nostra) · 🟡 fonte secondaria / plausibile · ❓ da verificare con test su device

---

## 0. Obiettivo e vincoli (decisi con l'utente)

| Voce | Decisione |
|---|---|
| Piattaforma | **Solo PWA (HTML+JS) eseguita in Safari su iPhone 17 Pro Max** — niente backend, niente app nativa, niente Mac |
| Input | Video `.mov` registrati da iPhone 17 Pro Max, 1080p, HEVC |
| Output | File riproducibile nell'app **Foto** di iOS → deve essere HEVC/H.264 standard in MP4/MOV |
| Risoluzione | **Invariata** (no downscale) |
| Criterio di successo | **≥ −50 % di spazio** e **nessuna differenza visibile a schermo intero su iPhone** |
| HDR | "Auto per file" (decidere per file se preservare HLG 10-bit o meno) |
| Filosofia | Non "abbassare la qualità": inventare una pipeline percettiva che pilota l'encoder hardware |

---

## 1. Analisi dei file campione (misurato da noi ✅)

| | IMG_2147.mov | IMG_7440.mov |
|---|---|---|
| Durata / size | 3.53 s / 6.79 MB | 8.71 s / 22.65 MB |
| Video | HEVC **Main 10**, `hvc1`, 1920×1080, yuv420p10le | idem |
| Bitrate video | 12.6 Mbps | **20.4 Mbps** |
| Frame rate | 60 fps nominale, **VFR** (avg 55.6 fps; 18 frame a 33 ms) | 59.94 nominale, VFR lieve |
| Colore | BT.2020 / **HLG (arib-std-b67)** / bt2020nc | idem |
| Dolby Vision | **Profilo 8.4** (BL HLG compatibile, RPU presente, no EL), level 5 | idem |
| Rotazione | display matrix −90° (verticale) | idem |
| GOP | keyframe ogni ~0.93 s | **keyframe ogni ~0.467 s (28 frame)** |
| Struttura | I/P/B (B gerarchici) | I ≈ 258 KB, P ≈ 79 KB, B ≈ 18.5 KB |
| Audio | `apac` (Apple Positional Audio = audio spaziale) 388 kbps **+** AAC-LC 211 kbps | AAC-LC 260 kbps (+ `cinematic-audio` nei metadati) |
| Tracce metadati timed (`mebx`) | 1 | **6** |
| moov | in coda (non fast-start) | in coda |

**Metadati QuickTime trovati (chiavi `mdta`)**: `creationdate` (con fuso orario), `make`, `model`, `software`, `full-frame-rate-playback-intent=0`, `scene-illuminance`, `milli-lux`, `camera.lens_model`, `camera.focal_length.35mm_equivalent`, `camera.lens_irisfnumber`, `apple-maker-note.*`, `live-photo-info`, `video-orientation`, `optical-center`, `segment-identifier`, `displayname`, **`detected-face` (+ `.bounds`, `.face-id`, `.roll-angle`, `.yaw-angle`)**, `cinematic-audio`. Nessuna chiave di location nei campioni (GPS probabilmente disattivato).

**Implicazioni immediate**
1. **GOP corto = spreco**: in IMG_7440 i 19 I-frame pesano ~4.9 MB su 22.6 MB (~22 %). Un GOP lungo con keyframe solo ai cambi scena è guadagno "gratis".
2. **Salienza gratuita**: la traccia `detected-face` fornisce i box dei volti per frame → ROI da proteggere senza ML.
3. **Stima rumore gratuita**: `scene-illuminance` / `milli-lux` per frame → in poca luce il sensore è rumoroso → forza del denoise adattiva.
4. **HDR**: base layer HLG 10-bit compatibile; perdere l'RPU Dolby Vision lascia un HLG valido.
5. **Audio spaziale `apac`**: va copiato as-is (passthrough) o si perde lo spaziale. Da verificare se il muxer lo supporta.
6. **VFR** già presente: il muxer deve preservare i timestamp reali.

## 2. Piattaforma: Safari iOS / WebKit / WebCodecs

## 3. Memoria su iOS Safari: limiti, crash, strategie

## 4. Container: demux / mux / metadati / audio

## 5. HDR, HLG, Dolby Vision

## 6. Algoritmi percettivi (pre-encoder)

## 7. Metriche di qualità eseguibili sulla GPU del telefono

## 8. Controllo dell'encoder: rate control, GOP, ricerca a circuito chiuso

## 9. Prior art su GitHub e nel web

## 10. Rischi, incognite e test da fare su device

## 11. Architettura proposta

## 12. Diario delle decisioni

---
### Nota operativa
Le ricerche di dettaglio stanno in `docs/research/*.md` (una per area). Questo file contiene la sintesi e le decisioni.
