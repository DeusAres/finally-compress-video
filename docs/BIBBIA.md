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

- 2026-11-18 — PWA only (no Mac). Codec output: HEVC via WebCodecs (AV1 encode non disponibile su iPhone/Safari). Criterio: ≥−50 % e nessuna differenza visibile a schermo intero.
- 2026-11-18 — Subagent: modello Sonnet per ricerca; risultati in `docs/research/`.

---

## 13. STATO / RIPRESA (leggere per primo)

**Fase attuale: RICERCA (pre-costruzione). Nessun codice app ancora.**

File di ricerca prodotti (leggerli prima di sintetizzare le sezioni 2–11):
- `research/02-webkit-webcodecs.md` ✅ (letto sorgente WebKit) — **VINCOLO CRITICO**: in Safari 27.0–27.2 l'encoder è il wrapper libwebrtc `RTCVideoEncoderH265` (VT **RealTime**, **no B-frame**, solo AverageBitRate, BitrateAdjuster); bitrateMode/quantizer/framerate/contentHint ignorati; keyFrame per-frame OK; configure() col solo bitrate = cambio al volo senza keyframe. **Niente VideoFrame 10-bit costruibili né copyTo 10-bit**; frame da canvas/WebGPU → NV12 8-bit; decoder release probabilmente 8-bit. VT diretto + 10-bit solo su WebKit `main` (futuro). WebGPU importExternalTexture mantiene 10-bit ma ignora colorSpace. → Nel release: **HDR 10-bit + pre-filtro GPU non fattibile**; opzioni: output 8-bit (SDR tone-mapped o HLG 8-bit ❓), attendere Safari futuro, o encoder WASM. Test device T0–T8 nel file.
- `research/03-memoria-ios.md` ✅ — limite WebContent soft ~1.5 GB (bug 277848), ~2–3 GB osservati; regole anti-crash con budget (frame in volo ≤4, decodeQueue ≤8, encodeQueue ≤4, footprint ≤700 MB); OPFS + createSyncAccessHandle in worker; Wake Lock in PWA da iOS 18.4; share sheet con file grandi problematico.
- `research/04-container-metadati.md` ✅ — Mediabunny 1.66: legge hvc1 Main10/colr/rotazione/VFR/tag mdta; NON scrive apac/mebx; tag mdta in udta/meta (Foto potrebbe ignorarli → post-processing moov/meta); usare fastStart:false + StreamTarget OPFS; pipeline manuale VideoSampleSink→Source (Conversion via canvas rischia 8-bit); copiare `amve` (TN3145) + mdcv/clli; rimuovere dvcC/dvvC; APAC: passthrough non supportato → proposta: scartare, tenere AAC.
- `research/05-esperimenti-proxy.md` ✅ — GOP lungo ≈ 6–10 % bitrate; denoise penalizzato dalle metriche FR; SSIM-Y 0.95 a ~9–10 Mbps (x265 faster) ≈ −50 %. VMAF da ottenere (serve permesso).
- `research/06-algoritmi-percettivi.md` 🟡 — molte citazioni ❓ (subagent con poche ricerche): **da verificare i paper prima di fidarsi dei numeri**. Ranking: per-scena + keyframe a scene-cut > denoise MC > JND in PU21/HLG > guardia banding > motion masking > ROI volti. Metrica in-loop: SSIM/MS-SSIM in PU21 + controllo banding; offline VMAF NEG / ColorVideoVDP.
- `research/09-prior-art.md` ✅ — kimymt/iphone-video-compressor (mediabunny, HEVC Main 8-bit, 34 pitfall Safari: niente IDR automatico, user activation, wake lock, 1 encoder HW, fastStart in-memory = RAM); nessuno fa Main10/HDR, pre-filtri WebGPU con metrica, per-scena HEVC, output grandi senza RAM → nostro spazio.

**Prossimi passi alla ripresa**
0. VMAF — distinzione: (a) LAB offline nel container = ground truth per calibrare (build libvmaf richiede permesso utente); (b) IN-APP = da studiare: ffvmaf (WASM) su frame campione per scena, costo su iPhone, vs MS-SSIM GPU / FUNQUE.
1. Decisione con utente sul vincolo 02 (8-bit vs attesa vs WASM) + prima build = pagina diagnostica T0–T8 da aprire sull'iPhone (verità sul device reale, Safari 27.x).
2. Verificare le fonti ❓ di `06` (subagent Sonnet dedicato, solo verifica paper + numeri).
3. Chiedere all'utente il permesso per compilare libvmaf (bloccato dal classificatore) → rifare ladder con VMAF/VMAF-NEG + clip low-light.
4. Sintetizzare sezioni 2–11 di questa BIBBIA dai file research + elenco "Test da eseguire su device" unificato (prima build = pagina diagnostica che esegue isConfigSupported & co. sull'iPhone).
5. Architettura proposta → approvazione utente → costruzione.

---
### Nota operativa
Le ricerche di dettaglio stanno in `docs/research/*.md` (una per area). Questo file contiene la sintesi e le decisioni.
