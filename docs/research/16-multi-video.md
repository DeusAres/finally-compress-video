# 16 — Più video contemporaneamente: limiti di encoder, decoder, `<video>` e memoria

Legenda: ✅ fonte primaria (sorgente WebKit, Apple, misura nostra) · 🟡 secondaria (forum, stampa, report di terzi) · ❓ non verificato / da misurare sul device.
Data ricerca: 2026-11-25. Sorgente WebKit letto: `main` @ `b739a1b3` (25/11/2026). Nessuna fonte trovata su iOS 27 / A19 Pro per i numeri esatti: tutto ciò che è numerico va confermato con `tools/diag/multi.html`.

Pagina di prova: **`tools/diag/multi.html`** (online: `https://deusares.github.io/finally-compress-video/tools/diag/multi.html`).

## 0. Sintesi

- **Nessun limite «di software» basso**: WebKit non pone un tetto al numero di `VideoEncoder`/`VideoDecoder` per pagina (✅ sorgente) né al numero di `<video>` **muti** in riproduzione (✅ sorgente: la restrizione di concorrenza vale solo per i video con audio udibile).
- **Il limite vero è l'hardware condiviso**: un solo media engine di sistema serve tutte le sessioni VideoToolbox (decoder dei `<video>`, encoder HEVC, encoder di prova, `VideoDecoder`). Apple non pubblica quante sessioni regga né se l'A19 Pro abbia più di un motore di encode (❓). Più sessioni **si dividono** la stessa capacità: il totale fps non può superare il tetto dell'encoder (misurato da noi ~163–200 fps a 1080p, ✅ BIBBIA §2/§11).
- **Oggi una pipeline non satura l'encoder**: con 2 player il collo di bottiglia è l'estrazione (seek + rVFC, ~90–100 fps ✅), l'encoder ne regge ~160–200. Quindi **2 video in parallelo possono dare un guadagno** (atteso fino a ~1.6–2× a 1080p ❓), **oltre N = 2–3 nessun guadagno atteso** e più rischi.
- **Rischio stabilità**: report Apple Developer Forums (giugno 2026) di **kernel panic** (riavvio del telefono) con **due encode HEVC hardware concorrenti** su iPhone 16 Pro / iOS 26.5; un ingegnere Apple dice di averlo riprodotto (FB23045975). Non sappiamo se riguardi iOS 27 / A19 Pro (❓). L'app usa già 2 encoder di prova insieme (prove per scena) senza panic segnalati, ma non c'è una misura dedicata.
- **Memoria**: iPhone 17 Pro Max ha 12 GB di RAM (🟡), ma il limite che conta è quello **per processo**: WebContent ~2 GB «ActiveHard» su iPhone 17 Pro iOS 26.x (🟡 log kernel di terzi), più il GPU process (limite ❓) dove vivono decoder, frame e sessioni VT.
- **Raccomandazione preliminare**: **coda sequenziale** di default (un video alla volta, 2 player, come oggi); **parallelo a 2** solo se `multi.html` mostra sul device ≥ 1.3× di fps totali, 10 bit in uscita, bitrate corretto e nessun errore/crash ripetuto. Mai oltre 2.

## 1. VideoToolbox: quante sessioni encoder/decoder?

- ✅ Apple non documenta un numero. La documentazione di `kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder` dice solo che l'encoder HW può non essere disponibile se le risorse sono occupate. https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder
- ✅/🟡 Apple Developer Forums, thread 831532 (giugno 2026, «How many concurrent VTCompressionSession / VTDecompressionSession can an app run, and can the limit be queried?»): risposta di un **Engineer Apple**: «è valido usare più VTDecompressionSession e più VTCompressionSession», «ogni EncodeFrame/DecodeFrame si blocca a una soglia di back-pressure», «i limiti dovrebbero essere abbastanza alti… e a quel punto dovresti ricevere codici d'errore, non crash». Il limite **non è interrogabile** (nessuna API citata). https://developer.apple.com/forums/thread/831532
  - Nello stesso thread: con **2 encode HEVC hardware concorrenti** (sorgente 4K60 HEVC HDR → proxy 720p HEVC) l'iPhone 16 Pro / iOS 26.5 (23F77) va in **kernel panic** (`dart-ave1 … DART(CPUDART) error: SID 0 PTE invalid exception`, cioè errore IOMMU del Apple Video Encoder). Non termico, non jetsam. Apple: «credo di aver riprodotto un panic corrispondente», FB23045975. 🟡 (stato del fix ignoto; iOS 27 ❓).
- 🟡 Thread 83385 (2017, «Maximum limit on H.264 hardware encoders and decoders»): stessa domanda, nessuna risposta Apple con numeri. https://developer.apple.com/forums/thread/83385
- 🟡 Numero di motori di encode: per i chip Mac Apple dichiara esplicitamente «two video encode engines» sulle versioni Max (M1 Max/M4 Max); per gli iPhone (A19 Pro) le specifiche non lo dicono → si assume **un motore** ❓. https://www.apple.com/newsroom/2021/10/introducing-m1-pro-and-m1-max-the-most-powerful-chips-apple-has-ever-built/ ; https://discussions.apple.com/thread/256019771
- 🟡 Prior art (`kimymt/iphone-video-compressor`, research/09): «VideoToolbox ha un solo encoder HW»; benchmark 1 vs 2 encoder all'avvio, se lo speedup < 1.3× resta a 1; lock anti doppio tap perché 6 encoder HEVC rischiavano il crash.
- Conseguenza: **N encoder si dividono lo stesso motore** (time-slicing). Il totale fps può solo avvicinarsi al tetto del motore; per pipeline gli fps scendono ~1/N quando il motore è saturo.

## 2. WebKit: limiti su VideoEncoder/VideoDecoder per pagina (sorgente)

Percorso: `VideoEncoder` (WebContent) → IPC → GPU process `LibWebRTCCodecsProxy` → `GPUVideoEncoder` → libwebrtc `RTCVideoEncoderH265` → VideoToolbox (research/02).

- ✅ **Nessun tetto al numero**: `LibWebRTCCodecsProxy` tiene encoder e decoder in `HashMap` (`m_encoders`, `m_decoders`) senza contatori né massimi. Unici controlli in `createEncoder`: codec H.264/H.265, configurazione valida, dimensioni ≤ 16384. `Source/WebKit/GPUProcess/webrtc/LibWebRTCCodecsProxy.mm` r. 339–391.
- ✅ **Se VideoToolbox rifiuta la sessione** (`GPUVideoEncoder::create` → null) il callback torna `false` e in JS arriva **`NotSupportedError`** sulla callback `error` dopo `configure()` (non un'eccezione sincrona). Un guasto durante la codifica arriva come **`EncodingError`**. `Source/WebCore/Modules/webcodecs/WebCodecsVideoEncoder.cpp` r. 239, 283, 364.
- ✅ **Niente `QuotaExceededError` / reclamation** dei codec in WebKit (nessuna occorrenza in `Modules/webcodecs`; la «codec reclamation» con `QuotaExceededError` è di Chromium). Se compare su Safari va annotato come nuovo.
- ✅ **Una sola coda di lavoro per tutto il GPU process**: `m_queue(webProcessConnection.gpuProcess().libWebRTCCodecsQueue())` (r. 79). Tutti gli encoder/decoder WebCodecs di tutte le schede passano per la stessa `WorkQueue` seriale per IPC e consegna dei frame (la codifica vera è asincrona in VT). Possibile collo di bottiglia secondario con molti codec ❓.
- ✅ `maximumCodecOperationsEnqueued()` = 16 per encoder/decoder (`WebCodecsVideoEncoder.h` r. 74): oltre, `encodeQueueSize` cresce in JS; l'app tiene ≤ 4.
- ✅ Il GPU process non può uscire sotto pressione di memoria finché esiste un codec (`allowsExitUnderMemoryPressure` = `!m_hasEncodersOrDecoders`, r. 558–561): codec non chiusi = memoria del GPU process trattenuta. → chiudere sempre.

## 3. Quanti `<video>` attivi/decodificanti in Safari iOS

- ✅ WebKit: su iOS la restrizione `ConcurrentPlaybackNotPermitted` è applicata **solo** al tipo `VideoAudio` (video con audio udibile); i `<video>` **muti** sono tipo `Video` e hanno solo `BackgroundProcessPlaybackRestricted` (+ `BackgroundTabPlaybackRestricted` se la RAM è < 1 GB). `Source/WebCore/platform/audio/ios/MediaSessionManagerIOS.mm` r. 78–91; `MediaSessionManagerInterface.cpp` `enforceConcurrentPlaybackRestriction`. Jer Noble (Apple, maggio 2025): la restrizione per più video udibili resta su iOS. https://lists.webkit.org/pipermail/webkit-dev/2025-May/032756.html
  → Nessun limite WebKit sul numero di `<video>` muti (i nostri: `muted`, `playsInline`, in pausa + seek).
- 🟡 Limite **AVFoundation/hardware** (fuori da WebKit): ogni `<video>` = un AVPlayer + AVPlayerItem nel GPU process, con una sessione di decodifica. Report storici: 4 «render pipeline» su iPhone 5s/iOS 8, 16 su iPhone 6s, «32» su iPhone 6 (WebKit bug 193449, numero forse redatto); oltre il limite `play()` fallisce o compare `AVErrorDecoderTemporarilyUnavailable` (-11839); **un video in pausa occupa comunque il decoder**; possibile limite di creazione anche dopo la rimozione (bug 170969, 2017). https://bugs.webkit.org/show_bug.cgi?id=193449 ; https://bugs.webkit.org/show_bug.cgi?id=170969 ; https://developer.apple.com/forums/thread/67382 ; https://developer.apple.com/forums/thread/28714
  - Per A19 Pro / iOS 27: ❓. Contano anche il `<video>` della PiP e i player delle prove per scena.
- ✅ Misure nostre: 2 player sullo stesso file funzionano (estrazione parallela v0.24, ~90–100 fps); il 2° player a volte non conferma i primi frame (riscaldamento, research/13). Con più pipeline questo può peggiorare ❓.

## 4. Memoria per tab prima del jetsam (iPhone 17 Pro Max)

- 🟡 RAM 12 GB: confermata da MacRumors tramite Xcode 26 (Apple non la pubblica). https://www.macrumors.com/2025/09/09/iphone-17-pro-iphone-air-ram-amounts/
- 🟡 Limite del processo WebContent su **iPhone 17 Pro** (12 GB), iOS 26.3–26.4.1: log kernel `com.apple.WebKit.WebContent exceeded mem limit: ActiveHard 2048 MB (fatal)`; l'entitlement `increased-memory-limit` non si applica a WebContent; risposta Apple: gli iPhone hanno limiti jetsam più restrittivi degli iPad. https://developer.apple.com/forums/thread/823061
- ✅ Storico: soft limit ~1.5 GB (WebKit bug 277848); 🟡 ~3 GB osservati su iPhone 15 Pro (research/03). iOS 27: ❓.
- ❓ **GPU process**: limite proprio non documentato. Lì vivono AVPlayer, buffer decodificati (IOSurface), sessioni VT e i `VideoFrame` nativi (lato WebContent c'è solo un riferimento). Un crash del GPU process interrompe i media di tutte le schede (thread 822200, iOS 26.4, causa non chiarita). https://developer.apple.com/forums/thread/822200
- Stima ordine di grandezza per pipeline (❓ da misurare): frame 1080p 10 bit 4:2:0 ≈ 6 MB; ≤ 4 frame in volo + riferimenti interni VT + buffer AVPlayer di 2 player → decine di MB nel GPU process, ×4 per il 4K. Lato WebContent poco (chunk a 8 Mbps ≈ 1 MB/s, scritti su OPFS dall'app).
- ✅ Safari non espone `performance.memory` (BIBBIA §3): la pagina lo registra se c'è (Chromium) ma su iPhone la memoria si vede solo **indirettamente**: kill della scheda = scalino iniziato e mai finito nel log persistente.

## 5. Throughput: N encode in parallelo sommano o si dividono?

- ✅ Misure nostre (1 pipeline): encoder HEVC 1080p da canvas 163 fps (T-run1), ~200 fps dal frame nativo (BIBBIA §11); estrazione seek+rVFC ~60 fps con 1 player, ~90–100 fps con 2 player (v0.24). Collo di bottiglia attuale: **estrazione**, non encoder.
- Deduzione (❓ da confermare): con N pipeline il totale ≈ min(N × estrazione, tetto encoder, tetto decoder/AVPlayer). A 1080p: N=2 → fino a ~160–200 fps totali (≈ 1.6–2×), N≥3 → piatto o in calo (contesa, rVFC mancanti, timeout di seek). In 4K il tetto encoder è ~4× più basso → probabilmente **nessun guadagno** già a N=2.
- ✅ Effetto collaterale sul bitrate: il rate control VT realtime dipende dal ritmo di alimentazione (BIBBIA §8/§11); con encoder rallentati dalla contesa il bitrate reale può spostarsi; il controllo a circuito chiuso (`brctl.js`) corregge per segmento. La pagina riporta i kbps reali per scalino (target 8000).
- 🟡 Calore: più sessioni = motore al 100 % più a lungo; throttling termico su code lunghe ❓ (non diverso dalla coda sequenziale a parità di lavoro totale).

## 6. Cosa misura `tools/diag/multi.html`

- Tre scale a scalini N = 1, 2, 3, 4, 6, 8 (fino a 12/16 se scelto):
  1. **pipeline completa**: per ognuna 1–2 `<video>` (seek + rVFC prima del seek, come `app/lib/frames.js`) → `new VideoFrame(video)` → `VideoEncoder` HEVC 8 Mbps sulla risoluzione nativa, 150/240/300 frame;
  2. **solo encoder**: N encoder alimentati con 6 frame nativi (10 bit) del primo video ciclati (o frame sintetici da canvas, 8 bit, se non c'è video);
  3. **solo `<video>`**: N×P player che fanno solo seek + rVFC + `VideoFrame` chiuso subito.
- Per scalino: fps totali e per pipeline (min–max), bit depth/profilo dall'`hvcC` (deve restare 10), kbps reali, doppioni/rVFC mancanti, errori (`configure`/`encode`/`flush`/seek, nome DOMException: `NotSupportedError`, `EncodingError`, `QuotaExceededError`…), `performance.memory` se c'è, tempo.
- Si ferma al primo errore, alla perdita dei 10 bit o a un **calo netto** (fps totali < 85 % del migliore; disattivabile). Watchdog: 25 s senza frame = stallo.
- **Log persistente**: ogni passo è scritto **prima** di eseguirlo («sto per avviare … N=…») in `localStorage` (sincrono) e in IndexedDB (`durability: 'strict'`, attesa del commit + 300 ms prima di partire); fasi interne e avanzamento ogni secondo. Alla riapertura la pagina unisce i due log e mostra «Interrotta durante … N=…, ultima fase …, ultimo avanzamento …» = punto di crash.
- Fra uno scalino e l'altro: `close()` di frame ed encoder, `revokeObjectURL`, `removeAttribute('src')` + `load()` dei `<video>`, pausa di 0.8 s.
- Provata in Chromium headless (Playwright, `tools/lab/multi_diag_test.mjs`): nessun errore JS, crash simulato (reload a metà scalino) rilevato, «Riprendi» riparte dallo scalino successivo. Chromium non codifica HEVC → ripiego H.264 dichiarato nel log (valori di fps **non** indicativi dell'iPhone).

## 7. Come leggere i risultati sul device (criteri di decisione)

| Esito | Decisione |
|---|---|
| pipeline N=2 ≥ 1.3× N=1, bit 10, kbps ≈ 8000, nessun errore | coda con **2 video in parallelo** possibile (opzione), default ancora da valutare con PiP/background |
| N=2 < 1.3× o calo | **coda sequenziale** (nessun beneficio) |
| errore `NotSupportedError`/`EncodingError` a N=k | limite sessioni VT = k−1 (con 2 player per pipeline) |
| scheda chiusa (crash nel log) a N=k | limite memoria/processo; restare ≤ k−1 con margine, cioè sequenziale se k ≤ 2 |
| telefono riavviato | panic del tipo thread 831532: **mai** encoder HEVC concorrenti (anche le prove per scena a 2 encoder vanno riviste) |
| solo encoder: totale piatto da N=1 | un solo motore, condiviso: il parallelo aiuta solo se l'estrazione è il collo di bottiglia |

## Fonti

- Apple Developer Forums 831532 (sessioni VT concorrenti, panic con 2 encode HEVC): https://developer.apple.com/forums/thread/831532
- Apple Developer Forums 83385 (limite encoder/decoder H.264): https://developer.apple.com/forums/thread/83385
- Apple Developer Forums 823061 (WebContent ActiveHard 2048 MB su iPhone 17 Pro): https://developer.apple.com/forums/thread/823061
- Apple Developer Forums 822200 (crash WebContent/GPU process iPhone 15): https://developer.apple.com/forums/thread/822200
- Apple Developer Forums 67382, 28714 (quanti AVPlayer): https://developer.apple.com/forums/thread/67382 ; https://developer.apple.com/forums/thread/28714
- WebKit bug 193449 (pool di video concorrenti, video in pausa occupano il decoder): https://bugs.webkit.org/show_bug.cgi?id=193449
- WebKit bug 170969 (limite di creazione di `<video>`): https://bugs.webkit.org/show_bug.cgi?id=170969
- WebKit bug 277848 (soft limit WebContent ~1.5 GB): https://bugs.webkit.org/show_bug.cgi?id=277848
- webkit-dev, Jer Noble, maggio 2025 (restrizione video udibili su iOS): https://lists.webkit.org/pipermail/webkit-dev/2025-May/032756.html
- MacRumors (RAM iPhone 17 da Xcode 26): https://www.macrumors.com/2025/09/09/iphone-17-pro-iphone-air-ram-amounts/
- Apple Newsroom M1 Pro/Max (motori di encode dichiarati sui Mac): https://www.apple.com/newsroom/2021/10/introducing-m1-pro-and-m1-max-the-most-powerful-chips-apple-has-ever-built/
- Sorgente WebKit `main` @ b739a1b3: `Source/WebKit/GPUProcess/webrtc/LibWebRTCCodecsProxy.mm`, `Source/WebCore/Modules/webcodecs/WebCodecsVideoEncoder.{h,cpp}`, `WebCodecsVideoDecoder.h`, `Source/WebCore/platform/audio/ios/MediaSessionManagerIOS.mm`, `Source/WebCore/platform/audio/MediaSessionManagerInterface.cpp`.
- Interni: BIBBIA §2, §3, §8, §11; research/02, 03, 09, 12, 13.
