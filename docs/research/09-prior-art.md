# 09 - Prior art su GitHub: compressione video in-browser con WebCodecs

Data analisi: 2026-11-18. Legenda: ✅ = letto nel codice sorgente (via raw.githubusercontent.com); 🟡 = solo README / pagina del repo.
Nota metodologica: i file sono stati letti tramite WebFetch, che restituisce riassunti e non numeri di riga; per questo gli URL puntano al file, non alla riga. Dove una citazione e' tra virgolette proviene dal sorgente. Le affermazioni "non fa X" vanno verificate sul codice prima di darle per certe.

---

## 1. kimymt/iphone-video-compressor ✅ (priorita' massima)
Repo: https://github.com/kimymt/iphone-video-compressor (MIT, 0 stelle, ma e' l'unico prior art diretto: PWA, iOS 26, HEVC, HDR->SDR).

**Cosa fa**
- PWA serverless per iOS 26+ Safari. Coda multi-file, 6 preset, condivisione via Web Share, Wake Lock, riavvio coda. Nessun upload, EXIF/GPS rimossi.
- Richiede iOS 26 perche' `AudioEncoder` non esiste su iOS 17-18.x. `canRun = VideoEncoder && AudioEncoder && h264Encode`; HEVC e' opzionale con fallback H.264.
- Fonte: https://github.com/kimymt/iphone-video-compressor/blob/main/CLAUDE.md , `README.md`, `CHANGELOG.md`, `TODOS.md`.

**Stack**
- Vite 5, React 18, TS strict, Zustand, Tailwind, vite-plugin-pwa (autoUpdate), OPFS + IndexedDB. **mediabunny** per demux + mux; nessun ffmpeg.wasm.
- Pipeline in `src/pipeline/`: `demux.ts`, `transcode.ts`, `mux.ts`, `rotate.ts`, `colorConvert.ts`, `audioPassthrough.ts`, `hevcBench.ts`, `video-diagnostics.ts`. Worker in `src/workers/compressor.worker.ts` (pool pre-riscaldato).
- https://github.com/kimymt/iphone-video-compressor/tree/main/src/pipeline

**Config encoder (transcode.ts ✅)**
- Decode via `VideoSampleSink` di mediabunny; l'encoder e' gestito a mano (config, backpressure, progress).
- `VideoEncoderConfig`: codec string dinamica, `hardwareAcceleration: 'prefer-hardware'`, `latencyMode: 'quality'`, `bitrateMode: 'variable'`, `framerate` dal demux, `colorSpace` forzato bt709 (primaries/transfer/matrix) con `@ts-expect-error` (i tipi DOM non lo conoscono; commento: Safari iOS accetta `'bt709'` come transfer).
- Codec string HEVC calcolata da lato lungo + fps: <=1280 -> `hvc1.1.6.L93.B0`; <=1920 -> `L120` (30fps) / `L123` (60fps); <=3840 -> `L153` / `L156`. Pitfall esplicito: "L93 fisso passa solo a 720p". H.264: `avc1.640028` (High) / `avc1.42E01F` (Baseline). Audio `mp4a.40.2`.
- **Solo profilo Main (8 bit, `hvc1.1.*`)**: nessun Main10 / `hvc1.2.4.*`. Scelta dichiarata in TODOS.md: "HEVC HDR output" fuori scope, conversione BT.2020->BT.709 one-way, "non aggiungere Main 10".
- Bitrate fisso per preset (best 12M, high 5M, standard 3M, light 1.5M a 720p, compat H.264 5M, min H.264 800k a 480p). Nessuna rate control adattiva al contenuto: bitrate costante per risoluzione.
- Forza keyframe sul primo frame e ogni 2 s (`KEYFRAME_INTERVAL_US = 2_000_000`, costo ~2-3% bitrate HEVC). Motivo (pitfall #33): il VideoEncoder WebKit non emette IDR automatico sul primo frame, quindi le miniature risultano bianche.
- Backpressure: sleep 16 ms finche' `encodeQueueSize` > `MAX_INFLIGHT_FRAMES` (HEVC 4, H.264 8). Abort controllato a ogni frame; progress throttled 200 ms; ETA solo dopo 10 s con velocita' recente.
- Errori: su qualsiasi fallimento `muxer.cancel()` per non lasciare file corrotti in OPFS; `input.dispose()` in `finally`; encoder chiusi.

**HDR (colorConvert.ts ✅)**
- Nessuna tone-mapping esplicita, nessun shader. `convertToBt709` fa `ctx.drawImage(frame)` su `OffscreenCanvasRenderingContext2D` e riavvolge il canvas in un nuovo `VideoFrame` copiando timestamp/duration. La conversione PQ/HLG->SDR e' demandata al compositing del browser (canvas sRGB). Il commento ammette: "exact tone mapping is browser-dependent and must be validated on iOS".
- Rilevamento: `needsSdrConversion` controlla sia il colorSpace del container sia quello del frame decodificato; `isHdrTransfer` = PQ o HLG. Il confronto e' per stringhe perche' `lib.dom.d.ts` non ha `'bt2020'`.
- Limite: tre canvas (HDR->SDR, rotazione, resize) = tre copie GPU/CPU per frame; nessuna misura del costo.
- https://github.com/kimymt/iphone-video-compressor/blob/main/src/pipeline/colorConvert.ts

**Rotazione / demux (demux.ts ✅, rotate.ts)**
- `new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })`. `videoTrack.getRotation()`; "VideoDecoder non applica la rotazione" -> correzione su canvas dedicato con dimensioni scambiate (`computeOutputDimensions`: swap w/h per 90/270, scale se lato lungo > max, arrotondamento a pari).
- FPS = media su primi 100 pacchetti (`computePacketStats(100)`), usata per `framerate` e livello HEVC; VFR passa i timestamp originali.
- https://github.com/kimymt/iphone-video-compressor/blob/main/src/pipeline/demux.ts

**Mux / memoria (mux.ts ✅)**
- `Mp4OutputFormat({ fastStart: 'in-memory' })`: commento "iOS Photos richiede moov all'inizio". `hvc1` di default da mediabunny. `setMetadataTags` mai chiamato (strip EXIF/GPS).
- Scrittura: `StreamTarget` -> `FileSystemWritableFileStream` OPFS con tracking posizione. Pero' `fastStart: 'in-memory'` implica che il file di output viene bufferizzato in RAM fino a `finalize()`: su video grandi e' il collo di bottiglia memoria (il repo imposta infatti "download mode" > 1 GB e riserva 2.5x spazio).
- Input: copiato in OPFS e letto come Blob (nessun load completo in RAM). Pitfall: non passare Blob enormi al main thread; il Worker scrive direttamente su OPFS.
- https://github.com/kimymt/iphone-video-compressor/blob/main/src/pipeline/mux.ts

**Audio (audioPassthrough.ts ✅)**
- Passthrough pacchetti AAC se: `mp4a.40.2`, 44.1/48k, <=2 canali, bitrate input <= 85% del target; altrimenti `AudioEncoder` AAC-LC a sample rate invariato. Disabilitato nel preset min. Evita drift da quantizzazione a 1024 campioni. Shift A/V condiviso se il primo timestamp e' negativo (mediabunny rifiuta timestamp negativi).

**Parallelismo / benchmark (hevcBench.ts ✅ da CHANGELOG)**
- `parallelism = hardwareConcurrency >= 6 ? 2 : 1`. Bench sintetico 720p 60 frame con 1 vs 2 encoder; se speedup `(2*serialMs)/parallelMs` < 1.3 -> degrada a 1 (VideoToolbox ha un solo encoder HW). Rieseguito ogni 90 giorni. Lock in-flight (un doppio tap lanciava 6 encoder HEVC e rischiava crash).

**Bug/workaround Safari documentati (CLAUDE.md pitfalls + CHANGELOG)**
1. `await` prima di `input.click()` consuma la transient activation: il picker non si apre (v1.2.3). Soluzione: handler `click` sincrono, `input.value=''`, `click()`, audio unlock fire-and-forget.
2. L'evento `change` non ha user activation: Wake Lock fallisce con `NotAllowedError` -> acquisire nel `click` sincrono. Rilascio dopo 60 s se il picker viene annullato.
3. Un secondo `AudioContext` resta `suspended` -> un solo contesto condiviso; interruttore silenzioso iOS silenzia WebAudio.
4. Niente IDR automatico (vedi sopra). 5. Livello HEVC dipende da risoluzione/fps. 6. DTS != PTS con B-frame. 7. VFR: non ricalcolare fps. 8. `deviceMemory` non esiste in Safari. 9. `navigator.vibrate` assente. 10. Wake Lock rilasciato su `visibilitychange`. 11. `startViewTransition` evitato. 12. Handle OPFS esclusivi. 13. Condivisione: `readFromOpfs` e' un handle lazy; se il file viene cancellato durante lo share, Photos riceve video vuoto/troncato -> copiare via `arrayBuffer()` prima. 14. Share > 1 GB fallisce -> `<a download>`. 15. Cold start Worker 0.5-2 s. 16. Race cancel/done: ignorare eventi tardivi su entrambi i lati. 17. Impostazione iPhone "Piu' compatibile" produce H.264 invece di HEVC. 18. Foto richiede tag `hvc1`.

**Idee riusabili**: tabella livelli HEVC; keyframe forzati; bench parallelismo; audio passthrough con soglia 85%; catena click sincrona; strip metadati; check quota 2.5x; diagnostica locale (`video-diagnostics.ts`: conta timestamp invertiti/duplicati e colorSpace distinti, senza pixel).

**Cosa NON fa**: nessun output 10-bit/HDR; nessuna tone-mapping controllata (affidata al canvas); nessuna rate control adattiva ne' VMAF/qualita' percettiva; nessun pre-filtro (denoise/sharpen); nessun WebGPU; bitrate fisso per preset; nessun resume mid-stream; nessun confronto A/B (esplicitamente escluso); issue tracker vuoto (nessuna segnalazione utente pubblica).

---

## 2. AskiOfficial/WebCompress 🟡
https://github.com/AskiOfficial/WebCompress (MIT, v0.2)
- Doppio motore con dispatcher: WebCodecs (worker: Mediabunny demux -> `VideoDecoder` -> OffscreenCanvas scale -> `VideoEncoder` prefer-hardware -> mp4-muxer -> ffmpeg.wasm per copiare video/audio e finalizzare il container) oppure ffmpeg.wasm `core-mt` con input montato via WORKERFS (no copia in RAM).
- Stack: React 19, Vite, Mediabunny 1.61.3, mp4-muxer 5.2, @ffmpeg/ffmpeg 0.12. Richiede COOP/COEP per SharedArrayBuffer.
- Qualita' 0-100 mappata su curve CRF per codec (H.264/H.265/VP9/AV1); target-size mode; AV1 solo via WebCodecs (`av01.0.04M.08`); tag `hvc1`; backpressure 8 decode / 6 encode; buffer demux 8 MiB.
- Nessuna sezione Safari; non documenta 10-bit/HDR/rotazione. Idea: dispatcher con capability probe + fallback software; diagnostica capability in un modal.

## 3. NickPax/donttouchmyvid ✅ (encoder.worker.ts)
https://github.com/NickPax/donttouchmyvid/blob/main/src/workers/encoder.worker.ts
- Astro + mp4box.js (demux) + mp4-muxer; H.264/HEVC MP4/MOV -> H.264 MP4, 3 preset.
- Encoder: `avc1.42E033` (Baseline 5.1), `bitrateMode:'variable'`, `prefer-hardware`, `latencyMode:'realtime'`, `avc:{format:'avc'}`; bitrate scala con i pixel (esponente 0.72 rispetto a 1080p) con soglie minime. `isConfigSupported` su encoder e decoder prima dell'uso.
- Trucco utile: `extractCodecBox` estrae `avcC`/`hvcC` e lo passa come `description` del decoder; va tagliato da `position` perche' `DataStream` di mp4box sovralloca il buffer (il padding rompe il decoder).
- Memoria: dichiara "bufferizziamo l'intero input in mp4box" (limite per file grandi, consiglia desktop Chrome). Code decode 6 / encode 3, altrimenti con moov-at-end la GPU esaurisce memoria. `firstTimestampBehavior:'offset'` definito "load-bearing". `fastStart:'in-memory'`, output singolo Blob.
- **Non fa**: nessuna rotazione (ignora i metadati), audio non-AAC scartato, nessun HDR, nessun workaround Safari (solo un messaggio d'errore HEVC); Safari 17.4+ "testato" ma senza dettagli.

## 4. kaixinol/webcodecs-compressor ✅ (core/pipeline.js)
https://github.com/kaixinol/webcodecs-compressor/blob/main/core/pipeline.js
- Alpine.js + **mediabunny `Conversion`** ad alto livello (`Conversion.init`, `forceTranscode`), `StreamTarget` -> OPFS con highWaterMark 16 MB; fallback File System Access API; ultima spiaggia RAM (64 MB HWM). Cancella il temp del run precedente.
- Resize nativo mediabunny `fit:"contain"` senza upscale; velocita' tramite callback `process()` che divide timestamp/duration.
- Bitrate: esplicito, oppure "original" = bitrate sorgente x1.2 (max 50 Mbps), oppure auto ~0.08 bit/pixel a 30fps (200 kbps-20 Mbps). `hardwareAcceleration` = `prefer-software` su richiesta.
- HDR: rileva BT.2020/PQ/HLG, avvisa "tone-mapped to SDR" e forza i tag a bt709, ma non c'e' passo di tone-mapping: e' solo etichettatura (rischio colori sbagliati se il decoder non converte).
- **Stall watchdog** 5 s (se non avanza il progresso annulla e suggerisce software encode): idea riusabile contro hang del VideoToolbox.
- Nessuna logica Safari/rotazione esplicita (delegata a mediabunny).

## 5. ColeSwinford/local-ai-video-compressor ✅ (allocator/encoder/complexity/saliency/blurShader)
https://github.com/ColeSwinford/local-ai-video-compressor/tree/main/src
- Obiettivo: file size esatto (es. limiti Discord/email) con 2 passate in browser.
- **Pass 1** (`complexity.ts`): ONNX (WebGPU) su 224x224 ogni 15 frame (`inferenceStride`), punteggio = sigmoid(media |output modello|) + 1.5 x MAD pixel tra campioni. Euristica non giustificata, con fallback *mock random* se il modello manca (rischio di dati falsi). Mediabunque non usato: demux mp4box/mkv custom.
- **Pass 2** (`allocator.ts`): budget video = max(25% target, (target - audio - 1.5% overhead) x 0.92); segmenti spezzati a salto di complessita' (>1.4x), 30 frame o 1 s; peso = score normalizzato^1.2; clamp [max(100k, 0.55 x media), 2.2 x media]; EMA asimmetrica (alpha 0.85 su, 0.15 giu'); keyframe su salti e ogni 2 s. Dichiara che la dimensione e' un target, non una garanzia.
- Encoder (`encoder.ts`): solo H.264 High (`avc1.64002a`/`640033`/`640034` per livello), `bitrateMode:'constant'`, `prefer-hardware`, SDR bt709 `fullRange:false`, **ricollega la config (`configure`) ai confini di keyframe solo se delta >= 8% e >= 15 frame** ("per evitare stall del driver"). Nessun controllo di `encodeQueueSize`.
- Pre-filtro percettivo (`saliency.ts` + `blurShader.ts`): modello di saliency 256x256 ONNX/WebGPU; shader **WebGL2** (non WebGPU) box blur 9x9 mixato per maschera (`mix(blurred, sharp, mask)`) per sfocare lo sfondo e liberare bitrate. Percorso frame: VideoFrame -> canvas 2D Display-P3 (tone map HDR dichiarata, non verificata) -> texture WebGL -> canvas 2D -> `new VideoFrame(..., colorSpace bt709 fullRange:true)`. Nota: `fullRange:true` in uscita contrasta con `fullRange:false` della config encoder (possibile mismatch di range). Maschera senza smoothing temporale (flicker); il blur campiona anche i pixel del soggetto (bleed).
- Audio AAC originale rimuxato con mp4box (passthrough). **Non fa**: HEVC, 10-bit, HDR vero, rotazione, test su iOS; nessuna metrica di qualita' (VMAF/SSIM) per validare il risultato.

## 6. MonsterInstitute/webcodecs-vs-ffmpeg-wasm 🟡
https://github.com/MonsterInstitute/webcodecs-vs-ffmpeg-wasm
- Harness di benchmark: 20 s 1080p -> 720p H.264 2 Mbps, audio copiato; Mediabunny 1.62.1 (WebCodecs HW e SW) vs ffmpeg.wasm 0.12.15 ST/MT vs ffmpeg nativo. Qualita' misurata con VMAF (`vmaf.py`, libvmaf). Headless Chrome, non Safari.
- Numeri nel `results.json` (non letto). Note pratiche: con ffmpeg.wasm MT va impostato `-threads` esplicito ("senza flag 6 errori; 8 e 12 appesi su M2 8-core"); la qualita' dell'encoder hardware varia per macchina.
- Utile come metodologia: stesso job, VMAF contro sorgente, un page fresco per job.

## 7. mayitayew/ffvmaf 🟡
https://github.com/mayitayew/ffvmaf
- FFmpeg + libvmaf (Netflix) compilati in WASM (Bazel: `BUILD`, `WORKSPACE`, `wasm/ffvmaf_wasm.cc`, `ffvmaf_lib.cc`), 6 stelle, MIT. README/modelli/prestazioni non letti. Idea: VMAF in-browser come misura di qualita' per un loop "target VMAF" (potenzialmente su un sottocampione di frame, non su tutto il file). Da verificare: peso del WASM, velocita' su iPhone, thread/SAB su Safari (richiede COOP/COEP).

---

## Progetti extra (selezione pertinente)

### 8. Vanilagy/mediabunny 🟡 (7.5k stelle) - https://github.com/Vanilagy/mediabunny
Toolkit TS puro per leggere/scrivere/convertire media in browser; usato da 4 dei 7 repo sopra. Base consigliata per demux/mux (BlobSource, StreamTarget, `Conversion`, `EncodedVideoPacketSource`, `fastStart`).

### 9. remotion-dev/remotion - webcodecs-bugs.mdx 🟡 (elenco, senza dettagli)
https://github.com/remotion-dev/remotion/blob/main/packages/docs/docs/mediabunny/webcodecs-bugs.mdx - catalogo bug WebCodecs per browser (segnalati da Vanilagy/JonnyBurger). **Safari/WebKit (6, 1 aperto)**: AAC AudioEncoder tratta i primi 1024 campioni come silenzio (WebKit 328491, aperto); decoder config AAC errata (302253, fixed); VideoFrame YUV da ArrayBuffer con `visibleRect` con croma sfalsato (317524, fixed); `AudioData.copyTo()` crash del tab (302521, fixed); WebM BlockGroup audio garbled (297781); VideoDecoder frame in ordine sbagliato (287516, fixed). Chrome (rilevanti per HEVC/HDR): HDR HEVC VideoFrame trasparente (fix 148), VideoDecoder ignora colorSpace H.264 su VideoToolbox macOS (aperto), `bitrateMode:'quantizer'` con grande ritardo iniziale (aperto), encoder si degrada se la pagina ri-renderizza (aperto), HEVC AMD primo chunk marcato delta (won't fix). Da controllare se i fix WebKit sono presenti nell'iOS target.

### 10. sb2702/webcodecs-fundamentals 🟡 - https://github.com/sb2702/webcodecs-fundamentals
Manuale + dataset (2.4 miliardi di test, 1087 varianti codec, 5 browser x 5 piattaforme) del supporto codec reale, con stringhe tipo `hvc1.2.4.L93.B0` testate. Da usare per scegliere codec string e per sapere cosa passa su iOS (la tabella e' un'immagine; il dataset e' su Zenodo/HuggingFace).

### 11. jakubkrapiec/alice-1 🟡 - https://github.com/jakubkrapiec/alice-1
LightGBM (quantile q10/q50/q90) che predice il CRF per un target VMAF da 20 feature (complessita' spaziale/temporale, movimento, fps, risoluzione, codec, 4 feature da una probe encode di 2 s). x264/x265/VP9/AV1, VMAF 60-95; MAE VMAF 1.47, CRF 0.53, 78% entro +-2 VMAF, ~12-14 s su 10 s di 1080p. Limiti: solo SDR 8 bit, dipende dal preset, accuratezza peggiore a target bassi e su CGI. Idea: stesso schema "probe corta + feature -> parametro" senza ricerca esaustiva, ma ricalibrato sul VideoToolbox.

### 12. alexheretic/ab-av1 🟡 - https://github.com/alexheretic/ab-av1
`crf-search` con "interpolated binary search" su sample brevi, `--min-vmaf`, `--max-encoded-percent`, `--min-xpsnr`; predice dimensione e tempo finali. E' il modello concettuale del "target VMAF". Non applicabile 1:1: il VideoEncoder WebCodecs non espone CRF ne' presets, solo bitrate (e `quantizer` con bug di latenza).

### 13. vbasky/viser 🟡 - https://github.com/vbasky/viser
Pipeline convex-hull per bitrate ladder per-title/per-shot da sweep CRF, con shot detection, BD-rate, VMAF. Fonte di idee per segmentazione per scena (cfr. allocator di Cole, che usa solo salti di complessita').

### 14. katana-video/carrot 🟡 - https://github.com/katana-video/carrot
Motore media JSON-IR con WebCodecs + WebGPU/WebGL2 + Mediabunny in worker; backend ML locali (denoise audio, trascrizione). Compositor dual-backend (WebGPU con fallback WebGL2). Supporto Safari "tracciato upstream in Mediabunny"; HDR assente. Utile come architettura di riferimento per pipeline GPU in worker.

### 15. sinchichou/YouTube-VSR 🟡 - https://github.com/sinchichou/YouTube-VSR
Estensione con shader WGSL modulari (denoise, upscaling, color correction) in tempo reale: riferimento per kernel WGSL di denoise, ma non per encode.

Ricerche senza risultati utili: "webcodecs hevc safari", "perceptual video preprocessing", "ab-av1 vmaf crf-search" come query repo; la ricerca code per `"hvc1.2.4"` restituisce solo tabelle di supporto (sb2702) e player; nessun compressore HDR 10-bit in browser trovato.

---

## Lezioni apprese

1. **Un solo concorrente diretto, e minimale**: l'unico progetto con stesso target (iOS Safari PWA, HEVC, HDR) usa bitrate fisso per preset e porta tutto a SDR 8 bit via canvas. Lo stato dell'arte pubblico e' basso: non c'e' molto da copiare sulla qualita', molto sulla robustezza.
2. **mediabunny e' lo standard di fatto** (kimymt, WebCompress, kaixinol, motori vari): demux robusto di MOV iPhone, rotazione, colorSpace, muxer con `hvc1`, `StreamTarget` su OPFS. mp4box.js (donttouchmyvid, Cole) funziona ma richiede di estrarre `hvcC`/`avcC` a mano e bufferizza l'intero file.
3. **Livello HEVC dinamico** (`L93/L120/L123/L153/L156` per risoluzione e fps): con un livello fisso `isConfigSupported` fallisce o l'encoder si rifiuta oltre 720p. Calcolarlo dal tabellone dei livelli e verificarlo sempre con `isConfigSupported`.
4. **WebKit non emette IDR sul primo frame**: forzare `keyFrame:true` sul primo frame e ogni ~2 s (costo 2-3% in HEVC), altrimenti miniature bianche e seek lenti. Da verificare se vale anche per Main10.
5. **Tag `hvc1` obbligatorio** per Photos/QuickTime; `fastStart` con `moov` in testa serve a iOS Photos. Mediabunny lo fa, ma `in-memory` carica l'output in RAM: per file grandi servono alternative (fragmented MP4 non e' accettato da Photos; valutare `fastStart:'reserve'`/due passate su OPFS).
6. **Rotazione non applicata dal VideoDecoder**: leggerla dal track e applicarla (canvas / `VideoFrame` con `rotation`/`visibleRect`) o scriverla come matrice nel muxer. donttouchmyvid e kaixinol la perdono o la delegano.
7. **HDR->SDR via `drawImage` su canvas e' non verificato**: affidarsi al compositing del browser produce colori dipendenti da browser/versione; nessun repo misura l'errore. Se vogliamo qualita', la tone-mapping va fatta noi (shader WebGPU/WGSL) con curve controllate, oppure restare in 10 bit Main10 (`hvc1.2.4.*`) mantenendo HLG/PQ. Etichettare soltanto (kaixinol) e' sbagliato.
8. **colorSpace va dichiarato sia in encoder config sia sul VideoFrame** (bt709; attenzione al mismatch `fullRange` di Cole: true sul frame vs false sull'encoder). Chrome ha bug aperti sul colorSpace H.264 su VideoToolbox: testare su dispositivo.
9. **Backpressure sempre**: `encodeQueueSize` con soglia bassa (HEVC 4, decode 6/encode 3 nei repo che la usano) + chiudere ogni `VideoFrame`/`AudioData`. Cole non la usa e senza cap la GPU puo' esaurire memoria con moov-at-end.
10. **Un solo encoder hardware su iPhone**: parallelismo spesso inutile o dannoso; benchmark all'avvio (1 vs 2 encoder, soglia 1.3x) e lock anti doppio-tap. Aggiungere uno **stall watchdog** (kaixinol, 5 s) per hang di VideoToolbox.
11. **Catena di user activation sincrona su iOS**: nessun `await` prima di `input.click()`, Wake Lock e `AudioContext.resume()` nel `click` (non in `change`); `input.value=''` prima del click; un solo `AudioContext`; l'interruttore silenzioso zittisce WebAudio. Wake Lock va riacquisito su `visibilitychange`.
12. **Audio**: AAC passthrough quando possibile (evita il bug WebKit 328491 "primi 1024 campioni silenzio" e il drift) con soglia di bitrate (kimymt 85%); se si ricodifica, mantenere il sample rate di origine. iOS 17-18 non ha `AudioEncoder`: serve fallback (passthrough o WASM) se vogliamo supportare versioni precedenti.
13. **Condivisione/file grandi**: copiare il file in memoria o `File` stabile prima di `navigator.share` (OPFS handle lazy -> video troncato); > ~1 GB fallisce, fallback `<a download>`; riservare ~2.5x lo spazio dell'input; rimuovere gli output parziali su errore/cancel; non lasciare che il Service Worker `autoUpdate` interrompa un job in corso (TODO aperto nel repo).
14. **Rate control**: WebCodecs espone solo bitrate (CBR/VBR) o `quantizer` (con ritardo iniziale e bug Chrome). Cole mostra che si puo' fare allocazione per segmento riconfigurando l'encoder ai keyframe (delta >= 8%, >= 15 frame), ma e' su H.264 CBR e senza verifica di qualita'. Nessuno usa VBR+HEVC con budget per scena.
15. **Misura prima di decidere**: webcodecs-vs-ffmpeg-wasm e alice-1 mostrano che la validazione con VMAF su clip corte e' praticabile; ffvmaf indica che VMAF in WASM esiste. Non e' ancora stato provato su iPhone (memoria, thread, tempo).
16. **Qualita' encoder HW dipende dal dispositivo**: un benchmark qualitativo va rifatto su iPhone, non su Chrome desktop.
17. **Test**: Playwright WebKit + test su dispositivo reale tramite tunnel HTTPS (Cloudflare) come in kimymt; i test headless non catturano i bug di user activation e VideoToolbox.

## Cosa nessuno fa ancora (nostro spazio di innovazione)

- **Output HEVC 10 bit (Main10, `hvc1.2.4.*`) con HDR preservato (HLG/Dolby non necessario) su iOS Safari**: tutti convertono a SDR 8 bit. Nessuno ha pubblicato test di `isConfigSupported` HEVC Main10 su iOS ne' del round-trip in Photos.
- **Tone-mapping HDR->SDR controllata e misurata** (WGSL/WebGPU, curva e gamut espliciti) anziche' `drawImage` implicito; con confronto di errore colore.
- **Pre-filtri percettivi WebGPU** (denoise temporale, deband, sharpening leggero) prima dell'encoder per abbassare il bitrate a parita' di qualita' percepita. Unico precedente: blur per saliency in WebGL2 (Cole), senza coerenza temporale e senza metrica.
- **Target-quality (stile ab-av1 / alice-1) in browser**: scegliere il bitrate per raggiungere un VMAF/SSIM obiettivo con probe su clip brevi + metrica (VMAF WASM o proxy leggero su GPU); oggi i repo usano bitrate fisso, bpp euristici o budget di dimensione.
- **Allocazione content-adaptive con HEVC VBR + verifica**: per-scena/per-shot (idee viser/Cole) usando un proxy di complessita' calcolato su GPU anziche' ONNX, con controllo post-hoc della dimensione/qualita'.
- **Gestione file grandi senza buffer in RAM** sull'output MP4 con moov in testa (nessuno risolve `in-memory` oltre ~1 GB su iOS).
- **Pipeline end-to-end zero-copy** (VideoFrame -> texture WebGPU `importExternalTexture` -> encoder) invece delle catene a 2-3 canvas; nessuno misura il costo o i limiti di memoria iOS.
- **Telemetria/benchmark di qualita' su iPhone reale** (VMAF, tempo, termica) pubblicata come dataset: oggi esistono solo benchmark Chrome desktop e il dataset di supporto codec.
