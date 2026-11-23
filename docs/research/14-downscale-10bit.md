# 14 — Downscale 4K → 1080p mantenendo HLG 10 bit

Data: 2026-11-23. Legenda come in BIBBIA: ✅ fonte primaria letta (sorgente WebKit / spec) o misura nostra · 🟡 inferenza dal codice · ❓ da misurare su device.
Pagina di prova: **`tools/diag/downscale10.html`** (online: `https://deusares.github.io/finally-compress-video/tools/diag/downscale10.html`).

## 1. Fatto misurato (punto di partenza)

✅ iPhone 17 Pro Max, Safari 27.0.1, app v0.35.1, IMG_1418 (2160×3840 HLG, DV 8.4): frame nativi 4K da `<video>` (`new VideoFrame(video)` dopo seek+rVFC, `format:null`, 10 bit) passati a un `VideoEncoder` configurato **1080×1920** (`hvc1.2.4.L123.B0`) → hvcC **profilo 1 (Main), bit depth 8**, coded 1088×1920. Lo stesso encoder senza downscale dà Main10 (research/02 §10 run 3). L'app oggi rileva il caso (`app/lib/downscale.js`, `verifyDownscale`) e ferma l'export; l'opzione «Riduci a 1080p» in UI ora lo dice esplicitamente.

## 2. Perché succede (spiegazione dal sorgente rilasciato)

- ✅ Spec WebCodecs: `VideoEncoderConfig.width/height` = dimensioni codificate; l'encoder **deve** scalare i frame di dimensione diversa. https://w3c.github.io/webcodecs/#dom-videoencoderconfig-width — la spec non dice nulla sul formato/bit depth da usare durante la scalatura.
- ✅ `RTCVideoEncoderH265.mm` (identico in `safari-7625.1.29.18-branch` e `safari-7625.2.8-branch`, cioè 27.0–27.2), metodo `encode:` r.279-290: un pixel buffer nativo senza crop viene passato **così com'è** a `VTCompressionSessionEncodeFrame`, con il commento «This pixel buffer might have a higher resolution than what the compression session is configured to. The compression session can handle that». La scalatura la fa quindi **VideoToolbox dentro la sessione**.
  https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk/objc/components/video_codec/RTCVideoEncoderH265.mm
- ✅ Stesso file, `resetCompressionSession` r.405-450: la sessione è creata con `sourceImageBufferAttributes` = **`kCVPixelFormatType_420YpCbCr8BiPlanarFullRange` (NV12 8 bit)** e nessun `ProfileLevel`.
- 🟡 Conclusione: quando le dimensioni coincidono VT codifica il buffer 10 bit nativo (→ Main10); quando no, VT deve trasferire il frame in un buffer delle dimensioni della sessione e usa il formato dichiarato nei `sourceImageBufferAttributes` (VTPixelTransferSession interno, cfr. `kVTCompressionPropertyKey_PixelTransferProperties`: https://developer.apple.com/documentation/videotoolbox/kvtcompressionpropertykey_pixeltransferproperties) → NV12 8 bit → Main. Coerente al 100 % con la misura (profilo 1, 8 bit, coded 1088). Da JS non si può cambiare né il formato del pool né `PixelTransferProperties`.
- ✅ `visibleRect` / `displayWidth` del `VideoFrame` non cambiano nulla: `new VideoFrame(frame, init)` condivide lo stesso `internalFrame` (WebCodecsVideoFrame.cpp r.398-415) e `WebCodecsVideoEncoder::encode` passa `frame->internalFrame()` (r.290-302): il buffer che arriva a VT è sempre quello 4K intero.
  https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WebCore/Modules/webcodecs/WebCodecsVideoFrame.cpp · https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WebCore/Modules/webcodecs/WebCodecsVideoEncoder.cpp
- ✅ Ogni frame costruito da immagine/canvas/ImageBitmap diventa un pixel buffer **BGRA8 sRGB** (WebCodecsVideoFrame.cpp r.259-266: `PixelFormat::BGRA8, DestinationColorSpace::SRGB()`), e nel GPU process i BGRA sono convertiti in **NV12 8 bit video range** prima dell'encoder (LibWebRTCCodecsProxy.mm r.489-497). Quindi canvas 2D float16, canvas WebGPU rgba16float (run 4 già misurato), ImageBitmap: tutti 8 bit.
  https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WebKit/GPUProcess/webrtc/LibWebRTCCodecsProxy.mm
- ✅ Nessun formato 10 bit costruibile da JS nel rilasciato (enum di 9 formati, research/02 §3). `VideoDecoder` non ha opzioni di dimensione d'uscita (spec) e nel rilasciato restituisce NV12 8 bit (run 4).

**Verdetto per Safari 27.0–27.2: non esiste un percorso JS che produca un frame 1080p a 10 bit da dare all'encoder HEVC.** È una dimostrazione dal sorgente, non una prova esaustiva: la pagina diag la verifica su device candidato per candidato.

## 3. Cosa cambia in WebKit `main` (non rilasciato al 23/11/2026)

- ✅ Encoder VT diretto (`GPUVideoEncoderVTB.mm`): sessione creata con `sourceImageBufferAttributes = nullptr` (r.217) e la sessione è ricreata se cambia il colorspace del frame. https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/video-codecs/cocoa/GPUVideoEncoderVTB.mm
- ✅ `GPUVideoEncoderVTBH265.mm` ora imposta **`kVTCompressionPropertyKey_ProfileLevel`** dal codec string: `hvc1.2.*` → `kVTProfileLevel_HEVC_Main10_AutoLevel` (`computeHEVCVTProfileLevel`, r.76-94; il contenuto di PR #81076 risulta in `main`). https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/video-codecs/cocoa/GPUVideoEncoderVTBH265.mm
- ✅ `I420P10/I422P10/I444P10/…12` costruibili da buffer (`VideoFrame::createPlanarYUV`, WebCodecsVideoFrame.cpp main r.341-360) ma **dietro `WebCodecsHighBitDepthEnabled`** (status `testable`, default `false`): flag spento → `TypeError`. https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/webcodecs/WebCodecsVideoFrame.cpp · https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml (voce `WebCodecsHighBitDepthEnabled`)
- 🟡 Con pool non forzato a NV12 e profilo Main10 dichiarato, è plausibile che la scalatura interna di VT resti a 10 bit → il percorso attuale dell'app (K1) potrebbe funzionare **senza cambiare codice** in una Safari futura. ❓ Non verificabile finché non esce una build con questi file (27.3 beta: branch `safari-7626*` non pubblico).

## 4. Candidati (ordine di probabilità di dare 1080p a 10 bit)

| # | Candidato (pagina diag) | Oggi (27.0.1) | Futuro | Motivo / fonte |
|---|---|---|---|---|
| K1 | Encoder che scala (percorso attuale) | ✗ misurato 8 bit | **più probabile** | pool NV12 8 bit forzato nel rilasciato; in `main` pool libero + ProfileLevel Main10 (§3) |
| K8 | `VideoFrame` I420P10 da buffer JS (GPU scala dai 10 bit, YUV ricostruito in JS) | ✗ atteso TypeError | probabile se il flag diventa attivo | `WebCodecsHighBitDepthEnabled` testable/off; serve anche che il frame P10 arrivi a VT come buffer 10 bit (❓) |
| K9 | `VideoTrackGenerator` + `applyConstraints(width/height)` + `MediaStreamTrackProcessor` (Worker) | ❓ atteso 8 bit o vincolo ignorato | bassa | la scalatura delle sorgenti MediaStream in WebKit è pensata per WebRTC (8 bit); non verificato nel sorgente |
| K2 | `VideoFrame(frame,{displayWidth,displayHeight})` | ✗ atteso = K1 | = K1 | `internalFrame` condiviso (§2) |
| K3 | `VideoFrame(frame,{visibleRect})` (ritaglio, controllo del percorso crop) | ✗ atteso = K1 (crop ignorato) | = K1 | idem; il PSNR contro il ritaglio lo dimostra |
| K5/K6 | Canvas 2D `colorType:'float16'` + `rec2100-hlg`/`display-p3` → `VideoFrame(canvas)` | ✗ atteso 8 bit (o contesto rifiutato) | molto bassa | frame da canvas = BGRA8 sRGB (§2); `rec2100-hlg` non è nell'enum in Chrome (misurato in Playwright) |
| K7 | WebGPU → canvas rgba16float extended → `VideoFrame(canvas)` | ✗ già misurato 8 bit (run 4, senza scalatura) | molto bassa | idem |
| K4 | `createImageBitmap(frame,{resizeWidth,resizeHeight})` → `VideoFrame` | ✗ atteso RGB 8 bit | molto bassa | idem |
| K0 | Nessun downscale (controllo) | ✓ Main10 (run 3) | ✓ | riferimento |
| — | Encoder WASM (x265 10 bit) con pixel letti in WebGPU | non provato | possibile ma lentissimo | WebGPU legge i 10 bit (`importExternalTexture` → formato Metal YCbCr10, research/02 §7; la pagina lo verifica col controllo livelli della sorgente); x265 WASM su iPhone: ordini di grandezza sotto VT, niente HW |
| — | `VideoDecoder` che scala | non esiste | — | `VideoDecoderConfig` non ha dimensioni di uscita (spec); decoder rilasciato = NV12 8 bit (run 4) |
| — | Ricodifica in due passaggi (4K Main10 → di nuovo `<video>`) | inutile | — | il frame decodificato torna 4K: stesso problema |

## 5. Cosa misura la pagina `tools/diag/downscale10.html`

Per ogni candidato, su N frame (default 10) estratti con seek + rVFC come l'app:
- eccezioni (prepare/configure/encode/flush), `isConfigSupported`;
- `VideoFrame` dato all'encoder: `format`, coded/display/visibleRect, colorSpace, e **griglia dei livelli** (regione 384×384 letta 1:1 in WebGPU: codici luma a 10 bit quasi tutti multipli di 4 ⇒ 8 bit; R/G/B su griglia 1/255 ⇒ RGB 8 bit; altrimenti 10 bit);
- uscita: hvcC (profilo, bit depth) + SPS (coded, area visibile, bit depth luma/chroma), `decoderConfig.colorSpace`, byte, keyframe;
- fedeltà: ri-decodifica con `VideoDecoder` → **PSNR-Y** contro la sorgente ridotta 2:1 in GPU (float) — grezzo e con guadagno/offset compensati (differenze di range) — oppure contro il ritaglio 1:1 per K3;
- **controllo 10 bit vero dell'uscita**: i chunk vengono messi in un MP4 minimo (muxer interno, provato con ffprobe/ffmpeg) e decodificati da `<video>` (decoder di sistema, frame nativi): formato e griglia dei livelli del frame centrale;
- sezione «Funzioni»: costruttori `VideoFrame` I420/NV12/I420P10/I422P10/I444P10/I420P12/P010, `copyTo` sul frame nativo (default, RGBA srgb/display-p3, I420P10, I420, rect), attributi canvas 2D HDR, canvas WebGPU HDR, `isConfigSupported` 1080p/4K.

Prova in Chromium (Chrome 153 headless, Playwright): nessun errore JS; muxer + `<video>` funzionanti (H.264), VP9 10 bit dà I420P10 anche scalato dall'encoder (Chrome scala in software a 10 bit), `rec2100-hlg` rifiutato dall'enum, `VideoTrackGenerator` assente. WebGPU nel sandbox non utilizzabile (device perso subito), quindi PSNR/livelli non verificati lì; per i browser senza `importExternalTexture` c'è un ripiego (`?noext`, copia in rgba16float) segnalato come «non indicativo dei 10 bit».

## 6. Cosa fare

1. Eseguire la pagina su iPhone con IMG_1418 (tutti i candidati) e incollare i risultati: attesi K0 ✓ Main10, K1–K7 8 bit o errore, K8 non disponibile. Il dato utile nuovo è il controllo livelli della sorgente (WebGPU legge davvero i 10 bit?) e l'esito di K9.
2. Rieseguire **K0+K1** dopo ogni aggiornamento di Safari (27.3, 28): se K1 diventa Main10 a 1080×1920 l'opzione dell'app funziona così com'è (la verifica `verifyDownscale` resta la garanzia); allora togliere «oggi non funziona» dall'etichetta.
3. Se compare `I420P10` (K8 ok in «Funzioni»), il percorso K8 è implementabile nell'app (costo: readback GPU + conversione JS per frame, da misurare).
4. Encoder WASM 10 bit: solo se l'utente accetta tempi molto lunghi; non pianificato.

## Esito sul device (iPhone 17 Pro Max, Safari 27.0.1, IMG_1418 4K HLG DV, 23/11, downscale10.html v1)

| Candidato | Uscita encoder | Note |
|---|---|---|
| K0 nessun downscale | **Main10, 10 bit** ✓ | controllo: livelli uscita ~985 su regione 384² |
| K1 encoder scala | Main, 8 bit ✗ | coded 1088×1920; livelli uscita 255 (= 8 bit) |
| K2 displayWidth/Height | Main, 8 bit ✗ | identico a K1 (stesso buffer 4K) |
| K3 visibleRect | Main, 8 bit ✗ | identico a K1 |
| K4 createImageBitmap resize | Main, 8 bit ✗ | ingresso BGRA 8 bit sRGB |
| K5 canvas rec2100-hlg float16 | — | TypeError (contesto non supportato) |
| K6 canvas display-p3 float16 | Main, 8 bit ✗ | ingresso BGRA 8 bit |
| K7 WebGPU rgba16float extended | Main, 8 bit ✗ | ingresso BGRA 8 bit |
| K8 VideoFrame I420P10 | — | TypeError: formati P10/P12/P010 non costruibili |
| K9 VideoTrackGenerator + applyConstraints | Main, 8 bit ✗ | applyConstraints senza effetto (frame ancora 4K) |

Altro: `copyTo` sul frame nativo → NotSupportedError «VideoFrame has no format» (anche con format/rect). **Confermato: su Safari 27.0.1 nessuna via JS per 4K→1080p a 10 bit.** Rieseguire K0/K1 a ogni aggiornamento di Safari.
