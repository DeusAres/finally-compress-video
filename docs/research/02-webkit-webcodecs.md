# 02 - WebCodecs VideoEncoder/VideoDecoder in WebKit (iOS) - stato reale

Data ricerca: 2026-11-18. Legenda: ✅ fonte primaria letta (sorgente WebKit / release notes Apple / spec) - 🟡 fonte secondaria o inferenza dal codice - ❓ non trovato, da testare su device.

## 0. Mappa versioni (fondamentale per interpretare tutto il resto)

- ✅ Safari 27.0 e 27.1 = build `20625.1.29` (branch `safari-7625.1.29-branch`); Safari 27.2 = `20625.2.8` (branch `safari-7625.2.8-branch`, 26 ott 2026); Safari 27.3 beta = `20626.1.17` (16 nov 2026). https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes.md , https://developer.apple.com/documentation/safari-release-notes/safari-27_2-release-notes.md , https://developer.apple.com/documentation/safari-release-notes/safari-27_3-release-notes.md
- ✅ Il branch `safari-7626` non e' pubblico su GitHub (404) -> il codice della 27.3 beta non e' ispezionabile. ❓ non so se la 27.3 contenga i commit di `main` successivi al 21 set 2026 (vedi sotto).
- ✅ Tutto cio' che e' stato letto su `safari-7625.1.29.18-branch` / `safari-7625.2.8-branch` = **codice rilasciato in iOS 27.0-27.2**. Tutto cio' che e' su `main` (GitHub, ott-nov 2026) = **non spedito (o non verificabile)**. Ogni punto sotto dice su quale dei due si basa.
- ✅ Il `VideoEncoder` HEVC diretto-VideoToolbox (`GPUVideoEncoderVTBH265`) e' stato introdotto in `main` il 21 set 2026, color space il 24 set; il decoder diretto (`GPUVideoDecoderVTB`) tra 24 e 28 set. Nei branch 7625.1.29.18 e 7625.2.8 questi file NON esistono (404). https://github.com/WebKit/WebKit/commits/main/Source/WebCore/platform/video-codecs/cocoa/GPUVideoEncoderVTBH265.mm , https://github.com/WebKit/WebKit/commits/main/Source/WebCore/platform/video-codecs/cocoa/GPUVideoDecoderVTB.mm

## 1. Implementazione dell'encoder (libwebrtc vs VideoToolbox diretto)

### 1a. Rilasciato (iOS 27.0-27.2): wrapper libwebrtc `RTCVideoEncoderH265` in modalita' "locale", dentro il GPU process
- ✅ Catena: `WebCodecsVideoEncoder` (WebProcess) -> `RemoteVideoCodecFactory::createEncoder` -> `LibWebRTCCodecs` -> IPC -> `LibWebRTCCodecsProxy::createEncoder` (GPU process) -> `webrtc::createLocalEncoder(SdpVideoFormat "H265", useAnnexB, ...)` -> `WK_RTCLocalVideoH264H265Encoder` -> `RTCVideoEncoderH265`. https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WebKit/WebProcess/GPU/media/RemoteVideoCodecFactory.cpp (r.167-191), https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WebKit/GPUProcess/webrtc/LibWebRTCCodecsProxy.mm (r.340-390), https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk/WebKit/WebKitEncoder.mm (r.364-395)
- ✅ Proprieta' VT impostate da `RTCVideoEncoderH265.mm` (`configureCompressionSession`, r.488-512): `RealTime` = `_isLowLatencyEnabled`; `AllowFrameReordering=false` (niente B-frame); `AverageBitRate` (via `setEncoderBitrateBps`, r.526-529); `MaxKeyFrameInterval=7200`; `MaxKeyFrameIntervalDuration=240` s. https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk/objc/components/video_codec/RTCVideoEncoderH265.mm
- ✅ NON impostati: `ProfileLevel` (riga commentata, r.494: `// kVTCompressionPropertyKey_ProfileLevel, _profile`), `DataRateLimits`, `Quality`, `ExpectedFrameRate`, `ColorPrimaries/TransferFunction/YCbCrMatrix`, `ConstantBitRate`, `MaxQP`. (grep sul file: nessun match.)
- ✅ Un `BitrateAdjuster(.5, .95)` (r.196) corregge `AverageBitRate` in base al bitrate reale misurato (puo' scendere fino al 50% del target quando l'encoder "sfora"). Questo vale anche in `main`: `GPUVideoEncoderBitrateAdjuster`, minAdjustedRatio .5 / maxAdjustedRatio .95, tolleranza 10% (GPUVideoEncoderVTB.mm r.46-122). -> il bitrate ottenuto puo' essere sensibilmente < di quello richiesto.
- ✅ Session creata con `kCMVideoCodecType_HEVC` e `sourceImageBufferAttributes` = NV12 8-bit full-range (r.417-446); encoder HW richiesto esplicitamente solo su macOS (`kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder` dentro `#if WEBRTC_MAC`), su iOS si lascia scegliere a VT; `RequiredLowLatency` solo se `latencyMode=realtime`, con fallback senza (r.455-476).
- ✅ I pixel buffer *nativi* (IOSurface) NON vengono ricopiati: se non serve crop/scale vengono passati direttamente a `VTCompressionSessionEncodeFrame` (r.274-290). Gli unici buffer convertiti dal proxy sono i `32BGRA` -> `420YpCbCr8BiPlanarVideoRange` (8-bit) con `PixelBufferConformerCV` (LibWebRTCCodecsProxy.mm r.489-497). Un buffer 10-bit nativo passa quindi intatto fino a VT.

### 1b. In `main` (non rilasciato): encoder VideoToolbox diretto in WebCore
- ✅ `GPUVideoEncoder::create`: H265 -> `GPUVideoEncoderVTBH265` (forza `scalabilityMode=L1T1`), H264 -> `GPUVideoEncoderVTBH264`, altri -> nullptr (restano libwebrtc). https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/video-codecs/cocoa/GPUVideoEncoder.mm (r.44-67)
- ✅ Proprieta' (https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/video-codecs/cocoa/GPUVideoEncoderVTB.mm r.223-261): `RealTime` = `isLowLatencyEnabled`; `AllowFrameReordering=false`; `ColorPrimaries/TransferFunction/YCbCrMatrix` copiati dai colorspace attachment del pixel buffer (r.232-243; la sessione viene ricreata se cambia il colorspace, r.298-305); `AverageBitRate` (r.280); `MaxKeyFrameInterval=7200`, `MaxKeyFrameIntervalDuration=240`; `BaseLayerFrameRateFraction=.5` solo per L1T2 (H264). Ancora nessun `ProfileLevel/DataRateLimits/Quality/ExpectedFrameRate` (`setRates` ha un FIXME: "we should set kVTCompressionPropertyKey_ExpectedFrameRate", r.287). Il PTS passato a VT e' in ms (`CMTimeMake(captureTimeMS, 1000)`, r.314-315), la duration a VT e' `kCMTimeInvalid` (r.319).
- ✅ `VideoEncoderVTBSession::create` passa `sourceImageBufferAttributes=nullptr` (https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/video-codecs/cocoa/VideoEncoderVTBSession.mm r.39-47; chiamata in GPUVideoEncoderVTB.mm r.213).
- ✅ PR #81076 (APERTA, non merged al 16 nov 2026, CI rossa): "HEVC VideoEncoder ignores the profile in the codec string". Descrive lo stato attuale: l'encoder non comunica mai il profilo a VT; VT sceglie Main per input 8-bit e Main10 per input 10-bit, sempre 4:2:0, a prescindere da `hvc1.1/hvc1.2/hvc1.4`. La PR aggiungerebbe `profile-id`/`interop-constraints` (RFC 7798) -> `ProfileLevel` e rifiuto se il profilo non e' supportato. https://github.com/WebKit/WebKit/pull/81076
- ✅ Le tracce di test in `main` mostrano che prima della PR #81076 anche nell'IPC `validateEncoderConfiguration` il codec string HEVC e' validato solo con `parseHEVCCodecParameters` + `validateHEVCParameters(params,false,false)` (capability del *decoder* VT, controlla profile IDC e livello <= MaxDecodeLevel), non con le capability dell'encoder (LibWebRTCCodecsProxy.mm r.304-330; HEVCUtilitiesCocoa.mm r.44-120).

## 2. Opzioni di `VideoEncoderConfig` realmente rispettate (Safari 27.2, `safari-7625.2.8-branch`)

Fonte: https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WebCore/Modules/webcodecs/WebCodecsVideoEncoder.cpp (r.77-125) e `WebCodecsVideoEncoderConfig.idl`.

- ✅ `codec`: prefissi accettati `hev1.` e `hvc1.` se `webCodecsHEVCEnabled` (default `true` su Cocoa, status "mature": https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml r.9556-9573). Poi `isConfigSupported` crea davvero un encoder (VT session) e riporta `supported = !!result` (r.348-370). Profilo effettivo: ✅ vedi 1a (ignorato; deciso da VT sul formato del pixel buffer). Livello/profile IDC solo validati contro le capability decoder VT.
- ✅ `width`/`height`: passati alla `VTCompressionSession`; input di dimensioni diverse sono scalati da VT (commento nel sorgente libwebrtc, r.274-279). `displayWidth/Height`: solo copiati nel `decoderConfig` di ritorno.
- ✅ `bitrate`: unico controllo di qualita'. Passa come kbps interi (`config.bitRate / 1000`, LibWebRTCCodecs.cpp r.597-598) -> `AverageBitRate`. Se omesso = 0 (r.124 `value_or(0)`): NON omettere. In `main` `bitrate==0` e' rifiutato (`isValidEncoderConfig`, enc.cpp r.123).
- ✅ `bitrateMode` ("constant"/"variable"/"quantizer"): presente nell'IDL (default "variable") ma **mai letto** da `createVideoEncoderConfig` -> sempre ABR di VT. `quantizer` non realizzabile.
- ✅ `latencyMode`: unico effetto = `RealTime` VT e `RequiredLowLatency` (`config.latencyMode == LatencyMode::Realtime`). Default "quality" = `RealTime=false` -> usare "quality" per la ricodifica offline.
- ✅ `framerate`: inoltrato a `initializeEncoder/setEncodeRates` ma `RTCVideoEncoderH265.setBitrate:framerate:` ignora `framerate` (r.386-391) e `ExpectedFrameRate` non e' impostato -> nessun effetto sull'encoding (solo rate control interno di VT dai PTS).
- ✅ `contentHint`: assente dall'IDL (https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WebCore/Modules/webcodecs/WebCodecsVideoEncoderConfig.idl) -> ignorato.
- ✅ `scalabilityMode`: H265 ammette solo `L1T1` (LibWebRTCCodecsProxy.mm `validateEncoderConfiguration`: `scalabilityMode != L1T1 -> false`); `L1T2/L1T3` su HEVC => non supportato; altro valore => TypeError.
- ✅ `alpha: "keep"` -> `NotSupportedError` ("Alpha keep is not supported", enc r.103-104 release).
- ✅ `hevc.format`: nel branch rilasciato 27.2 il dictionary `VideoEncoderConfig` NON ha il membro `hevc` (solo `avc`; IDL sopra) e `useAnnexB` dipende solo da `avc.format` (enc r.123) -> `hevc:{format:"annexb"}` ignorato; l'output e' sempre length-prefixed (formato "hevc"/hvcC) con `decoderConfig.description` = box `hvcC` (RTCVideoEncoderH265.mm r.593-606). Coerente con bug https://bugs.webkit.org/show_bug.cgi?id=281945 (NEW, "VideoEncoder.configure for H265 does not respect hevc.format annexb"). In `main` il membro `hevc` esiste e `annexb` e' onorato (enc.cpp r.147; `convertHEVCCMSampleBufferToAnnexB` in GPUVideoEncoderVTBH265.mm r.49-56); non sappiamo se arrivera' in 27.3. Per il progetto (MP4) il default "hevc/hvcC" e' quello giusto.
- ✅ Opzioni per frame (`encode(frame, options)`): `WebCodecsVideoEncoderEncodeOptions.idl` ha solo `keyFrame` (-> `kVTEncodeFrameOptionKey_ForceKeyFrame`, r.323-330 libwebrtc). `hevc.quantizer` (previsto da https://www.w3.org/TR/webcodecs-hevc-codec-registration/) **non esiste** in Safari.
- ✅ Altre assenze: nessun `DataRateLimits` (picchi non limitabili), nessun controllo GOP/`MaxKeyFrameInterval` da JS (fisso 7200 frame/240 s; keyframe periodici solo con `keyFrame:true` manuale), nessun B-frame (reorder off) -> efficienza di compressione inferiore a x265/ffmpeg a pari bitrate.

## 3. 10-bit e HDR

### Encoder
- ✅ Il codec string `hvc1.2.4.L123.B0` e' accettato come prefisso `hvc1.` e validato col profile IDC 2 (Main10) contro le capability decoder VT (vedi 1b). ❓ Se `isConfigSupported` risponde `true` su iPhone 17 Pro Max va misurato sul device (snippet T1).
- ✅ Il profilo reale e' deciso da VT in base al pixel format del buffer in ingresso (PR #81076, descrizione dello stato attuale; vedi 1b) -> input 10-bit nativo => Main10; input 8-bit => Main anche se la stringa dice `hvc1.2`. 🟡 (descrizione PR non merged, ma coerente col codice: `ProfileLevel` mai impostato).
- ✅ `VideoPixelFormat` nel branch rilasciato = solo 9 valori: `I420, I420A, I422, I444, NV12, RGBA, RGBX, BGRA, BGRX` (https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WebCore/platform/VideoPixelFormat.cpp r.84-95). **`I420P10`, `P010`: non esistono** (P010 non e' un valore WebCodecs in nessun caso). `new VideoFrame(buffer,{format:"I420P10"})` -> TypeError nel release.
- ✅ PR #75520 (MERGED 8 ott 2026, commit b6260a6): aggiunge `I420P10/I420P12/I422P10/I422P12/I444P10/I444P12` all'enum, dietro la preference `WebCodecsHighBitDepthEnabled` (default `false`, status `testable`: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml r.7375-7382). Preference off => TypeError; on => la costruzione da buffer lancia `NotSupportedError` "until frame creation for them is implemented". https://github.com/WebKit/WebKit/pull/75520 . ❓ Non si puo' prevedere se uno status `testable` sia attivabile da Settings > Safari > Avanzate > Feature Flag su iOS (verosimilmente no).
- ✅ PR #80933 (APERTA, non merged al 16 nov 2026, EWS con fallimenti): mappa i CVPixelFormat 10-bit biplanari in `I420P10` per i frame decodificati (altrimenti `format === null`), aggiunge creazione/copia di VideoFrame planari I422/I444/10-12 bit e `PlanarImageConverter`. https://github.com/WebKit/WebKit/pull/80933 -> **la scrittura di VideoFrame 10-bit da JS non e' disponibile in nessuna versione rilasciata e non lo sara' prima che #80933 entri**.
- ✅ Release notes 27.3 beta: "Fixed WebCodecs VP8, VP9, and AV1 encoders encoding uninitialized data for 10-bit frames. (189532957)" -> esistono frame 10-bit nativi (da decoder) che attraversano gli encoder; per H.265 nessuna nota specifica. https://developer.apple.com/documentation/safari-release-notes/safari-27_3-release-notes.md
- 🟡 Strada realistica per un frame 10-bit nativo verso l'encoder HEVC nel release: solo **passthrough** di un `VideoFrame` uscito dal `VideoDecoder` (pixel buffer nativo, nessuna elaborazione JS) perche' i buffer nativi non sono ricopiati (1a). Qualsiasi frame prodotto da canvas/WebGPU (`new VideoFrame(canvas)`) e' BGRA 8-bit e viene convertito in NV12 8-bit (LibWebRTCCodecsProxy.mm r.489-497) => HDR perso/banding. ❓ da verificare su device (T4).
- ✅ Colorspace input `{primaries:'bt2020', transfer:'hlg', matrix:'bt2020-ncl'}` per frame costruiti da ArrayBuffer: il `VideoFrameInit.colorSpace` esiste (`videoFramePickColorSpace`, WebCodecsVideoFrame.cpp) ma per i soli formati supportati (NV12/I420/RGB 8-bit). Nel release l'encoder libwebrtc non copia primaries/transfer/matrix nel bitstream (nessun `kVTCompressionPropertyKey_ColorPrimaries/TransferFunction/YCbCrMatrix` in RTCVideoEncoderH265.mm). ❓ Se VT li eredita dagli attachment del buffer (VUI nell'SPS) va letto su device parsando l'SPS dell'output (T5). In `main` sono copiati esplicitamente (GPUVideoEncoderVTB.mm r.232-243, commit "Preserve color space info when encoding/decoding H265 via VideoToolbox", 24 set 2026).

### Decoder
- ✅ `VideoDecoder.isConfigSupported({codec:'hvc1.2.4.L123.B0'|'hev1.2.4...'})`: prefissi `hev1./hvc1.` + validazione profile IDC/level vs `VTCopyHEVCDecoderCapabilitiesDictionary` (Main10 = IDC 2 incluso) (WebCodecsVideoDecoder.cpp r.74-83 release; HEVCUtilitiesCocoa.mm r.44-120). In `main` esiste il test `hevc-hdr.html` con `hev1.2.4.L30.90` che asserisce `supported === true`. https://raw.githubusercontent.com/WebKit/WebKit/main/LayoutTests/http/tests/webcodecs/hevc-hdr.html
- ✅ **Decoder rilasciato (27.0-27.2)**: `RTCVideoDecoderH265.mm` crea la `VTDecompressionSession` con `kCVPixelBufferPixelFormatTypeKey = 420YpCbCr8BiPlanarFullRange` (r.446) incondizionatamente. https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk/objc/components/video_codec/RTCVideoDecoderH265.mm -> 🟡 un Main10 HLG viene molto probabilmente **ridotto a NV12 8-bit** da VT prima di arrivare a JS (`frame.format === "NV12"`, nessuna null-format). ❓ da misurare (T2): se `frame.format==='NV12'` il frame e' 8-bit.
- ✅ **Decoder `main`** (`GPUVideoDecoderVTB.mm` r.51-81): per stream con bitDepth>8 richiede `420YpCbCr10BiPlanar{Full,Video}Range` => frame 10-bit nativo; `convertVideoFramePixelFormat` non lo mappa => `frame.format === null` (test `hevc-hdr.html`: "format is null for unrepresentable 10-bit content", `colorSpace` = bt2020/pq/bt2020-ncl/limited letto dal bitstream). PR #80933 farebbe riportare `I420P10`.
- ✅ `copyTo()` sul release: se `format==null` -> reject `NotSupportedError "VideoFrame has no format"` (WebCodecsVideoFrame.cpp r.493-497 release); `allocationSize()` idem; nessuna conversione di formato in `copyTo` (usa sempre `*m_data.format`). https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.2.8-branch/Source/WebCore/Modules/webcodecs/WebCodecsVideoFrame.cpp
- ✅ `main` (ott 2026): "Allow copyTo to convert to RGB on the fly" (15 ott), "copyTo colorSpace option" (16 ott), "copyTo should allow to convert to RGB even if VideoFrame.format is null" (16 ott), rotation/flip (19-27 ott). `copyTo(buf,{format:'RGBA'})` funziona su frame 10-bit/null-format, ma e' una conversione a 8-bit (colorSpace `srgb`/`display-p3`). https://github.com/WebKit/WebKit/commits/main/Source/WebCore/Modules/webcodecs/WebCodecsVideoFrame.cpp ; nessuna delle tre e' nelle release notes 27.0-27.3 beta -> ❓ assenti nel release.
- ❓ **Non esiste nessun percorso JS per leggere i piani YUV 10-bit** (`copyTo` su I420P10 non e' possibile finche' non entra #80933; P010 non e' un formato WebCodecs).
- ✅ Release notes pertinenti 27.0: "Added support for overriding color space for hardware video decoders in WebCodecs (178717498)"; "Fixed VideoDecoder output frames in incorrect order for videos containing B-frames (145093697)"; "HDR video content appeared washed out due to colorspace information being lost (172721079)"; "VideoFrame constructor did not handle color range for NV12 (170299037)". `VideoDecoderConfig.colorSpace` quindi forza i metadati (utile per clip HLG senza VUI). https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes.md

## 4. Riconfigurazione a meta' stream

- ✅ `configure()` sullo stesso encoder: se la config e' identica a quella attiva *salvo bitrate/framerate* -> solo `updateRates()` = `setEncodeRates` -> `AverageBitRate` aggiornato sulla sessione VT esistente; nessun flush, nessuna nuova sessione, **nessun keyframe forzato**, `hvcC` invariato e nessun nuovo `decoderConfig` nei metadata. (enc r.162-165 e 184-187, `updateRates` r.127-146 release; `m_isKeyChunkRequired=true` e' impostato ma mai letto: dead flag, grep sul file.) Pero' il `BitrateAdjuster` rimette il target e puo' ritardare la convergenza (cambio ogni ≥1 s/30 frame).
- ✅ Se cambia qualunque altro campo (width/height/codec/latencyMode/hardwareAcceleration...): `flush()` dei frame in volo, poi `VideoEncoder::create` => nuova `VTCompressionSession` => nuovo `hvcC` (`m_hasNewActiveConfiguration` -> `decoderConfig` con nuovo `description` sul prossimo chunk) e il primo frame e' naturalmente un IDR. I VPS/SPS/PPS possono quindi cambiare tra segmenti.
- ✅ Dopo `configure()` l'unica garanzia dello spec (primo output = key chunk) non e' imposta nel caso "solo rate": Safari non forza il keyframe. Se serve un taglio di GOP per segmento: passare `encode(frame,{keyFrame:true})`.
- ✅ In `main` `configure()` azzera anche `m_activeOrientation` e ricrea la `VTCompressionSession` quando cambia il colorspace dei frame in ingresso (GPUVideoEncoderVTB.mm r.298-305) => con frame misti SDR/HDR si hanno IDR + nuovo `hvcC` impliciti.
- 🟡 Cambiare bitrate per segmento nello stesso encoder e' supportato; per segmenti con `hvcC` garantito identico (concatenazione in un unico MP4 con una sola sample description) non fare cambi che innescano la ricreazione, oppure creare un nuovo encoder per segmento e gestire N sample entries / re-mux.

## 5. Timing dei frame (VFR)

- ✅ `timestamp` (µs, int64) e `duration` del `VideoFrame` arrivano come parametri separati fino all'encoder (`encode({frame, timestamp, duration}, keyFrame)`, enc r.302 release) e NON passano per il PTS di VT: a VT va solo `CMTimeMake(timeStampNs/1e6, 1000)` (ms) come riferimento di rate control (RTCVideoEncoderH265.mm r.350, `AllowFrameReordering=false` => output in ordine di input). I timestamp originali tornano dal `RTCFrameEncodeParams`.
- ⚠ ✅ `RTCFrameEncodeParams.timestamp` e il parametro callback sono `uint32_t` (RTCVideoEncoderH265.mm r.55-83, r.539) mentre l'ingresso e' `int64` (`frame.timeStamp`, RTCVideoFrame.h `int64_t timeStamp`): il timestamp di output e' **troncato a 32 bit** => wrap a 2^32 µs ≈ 71,6 min. Per clip < 71 min nessun effetto; oltre, usare timestamp rebasati/ricostruirli dall'ordine di output (che e' lo stesso dell'input, niente reorder). 🟡 (derivato dal sorgente, da confermare con T6).
- ⚠ ✅ La `duration` in uscita: `RTCVideoEncoderH265` non valorizza `RTCEncodedImage.duration` (nessun `frame.duration =` nel file); `WebKitEncoder.mm` r.379 copia la duration se `!= UINT64_MAX`. 🟡 Quindi `chunk.duration` nell'`EncodedVideoChunk` HEVC puo' risultare 0/null nel release. Non fidarsi di `chunk.duration`: tenere un array di (timestamp,duration) lato app indicizzato per ordine di output. In `main` la duration e' propagata (`GPUVideoEncoderFrameInfo{..., timeStamp, duration,...}`, GPUVideoEncoderVTB.mm r.354).
- 🟡 VFR (pts non multipli di 1/60) funziona perche' nessun reorder e PTS ms ≈ solo per VT; ❓ errore di rounding del PTS a ms nel rate control di VT non misurato. Timestamp non monotoni: ❓ non testato (VT puo' scartare/rifiutare PTS non crescenti).
- ✅ `info.isKeyframe` dal flag `kCMSampleAttachmentKey_NotSync` (r.557-566) -> `EncodedVideoChunk.type` corretto.

## 6. Bug / quirk noti rilevanti

- ✅ Bug 281945 (NEW): `hevc.format:'annexb'` ignorato (Safari 18.0.1 / STP 205); stato nel release 27.2: ancora ignorato (nessun membro `hevc` nell'IDL). https://bugs.webkit.org/show_bug.cgi?id=281945
- ✅ Bug 262950 (REOPENED): HEVC `isConfigSupported` true ma decode fallisce con "Decoder failure" (VT -12909) su certi file; fix parziale 271728@main (dic 2023). https://bugs.webkit.org/show_bug.cgi?id=262950
- ✅ Bug 258060: qualita' VideoEncoder scarsa su Mac Safari 16.4 (H.264, vecchio; indicativo del rate control conservativo). https://bugs.webkit.org/show_bug.cgi?id=258060 🟡 (non letto per intero)
- ✅ Release notes: 27.0 "VideoDecoder output frames in incorrect order for B-frames (145093697)"; "ArrayBuffer-backed YUV VideoFrame with visibleRect rendered with offset chroma (180202939)"; "VideoFrame constructor color range for NV12 (170299037)"; "I420 BT709 VideoFrame encoded in incorrect color space when encoding to VP9 (169425608)". 27.2: "VideoEncoder could stall and produce no output for H.264 Main and High (188201298)". 27.3 beta: "WebCodecs H.264 encoder buffering too many frames (188201578)", "VP8/VP9/AV1 encoders encoding uninitialized data for 10-bit frames (189532957)", "Added ImageDecoder (184857272)", "black video-range pixel buffers super-black (187309125)". https://developer.apple.com/documentation/safari-release-notes/
- ✅ Lista Remotion/mediabunny (https://www.remotion.dev/docs/mediabunny/webcodecs-bugs): per Safari solo audio/YUV-frame/ordine decoder (bug 328491 AAC primi 1024 sample silenti OPEN; 317524 chroma offset FIXED; 287516 ordine frame FIXED; 302253/302521/297781 fixati). Nessuna voce su HEVC/10-bit/bitrate/keyframe.
- 🟡 Forum Apple (thread 799316): su iOS 26 il VTCompressionSession HEVC puo' emettere piu' NAL per sample (gia' gestito da WebKit che copia l'intero `CMBlockBuffer`; da tenere presente per eventuali parser/muxer: non assumere 1 NAL per chunk). https://developer.apple.com/forums/thread/799316
- ✅ Il test WPT `hevc-encoder-config` verifica solo `hvc1.C99.6FFFFFF.L93` => isConfigSupported false / configure NotSupportedError. https://raw.githubusercontent.com/WebKit/WebKit/main/LayoutTests/http/wpt/webcodecs/hevc-encoder-config.https.any.js
- ❓ Nessun bug trovato (Bugzilla/GitHub) specifico su "HEVC Main10 encode" o su `bitrate` HEVC su iOS; vedi T-test sotto.

## 7. WebGPU in Safari iOS: `importExternalTexture` e 10-bit/HDR

- ✅ `GPUExternalTextureDescriptor.source` = `HTMLVideoElement` **o `VideoFrame`** (WebCodecs) nelle build con WEB_CODECS; `colorSpace` default "srgb". https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.1.29.18-branch/Source/WebCore/Modules/WebGPU/GPUExternalTextureDescriptor.idl
- ✅ Il percorso Metal (`Device::createExternalTextureFromPixelBuffer`, BindGroup.mm r.447-585) usa direttamente il `CVPixelBuffer` del frame (IOSurface -> `CVMetalTextureCache`) senza conversione a 8-bit. Per `420YpCbCr10BiPlanar{Video,Full}Range` (e 422/444 10-bit, e varianti packed lossless/lossy) il piano luma e' mappato a `MTLPixelFormatYCBCR10_*_2P` se `supportsFamily(MTLGPUFamilyApple4)`, altrimenti ricade su `R8Unorm/RG8Unorm` (r.378-388, 213-218): su A19 Pro vale il primo caso => precisione 10-bit mantenuta nel campionamento. https://raw.githubusercontent.com/WebKit/WebKit/safari-7625.1.29.18-branch/Source/WebGPU/WebGPU/BindGroup.mm
- ✅ **La trasformazione colore e' solo YCbCr->RGB lineare**: matrice 4x3 scelta da `kCVImageBufferYCbCrMatrixKey` (BT.709 / BT.601 / BT.2020, ramo Full vs Video range) (r.145-195). Il parametro `colorSpace` del descriptor e' `UNUSED_PARAM(colorSpace)` (r.450): **nessuna conversione di transfer (HLG/PQ), di primarie, nessun tone-mapping**. Il risultato campionato in WGSL e' quindi RGB HLG/BT.2020 codificato (non lineare), in float; sRGB 8-bit NON e' imposto. L'unico fallback: attachment matrix mancante => assume BT.709 (r.145-149).
- 🟡 `main` ha ancora `descriptor.colorSpace` passato ma usato solo per `m_colorSpace` in `ExternalTexture` (ExternalTexture.mm r.45-52): nessuna evidenza di conversione HDR. ❓ da verificare su device (T3).
- ✅ Percorso alternativo "copyTo in buffer + upload": nel release NON praticabile per 10-bit (nessun formato JS 10-bit, vedi 3). In `main` dopo #80933 sarebbe `copyTo(I420P10)` -> `queue.writeTexture` su `r16uint`/`r16unorm`. Oggi: solo `copyTo` NV12/8-bit (se il decoder rilasciato fornisce NV12).
- ✅ Note 27.3 beta: "WebGPU external texture imported from a video element using WebM or MSE playback rendered as black placeholder (186470526)" (non riguarda VideoFrame); "uploading a canvas as WebGPU texture had very poor performance (153642354)". Nessuna nota su HDR/10-bit in WebGPU in 27.0-27.3 beta.
- ❓ Cosa succede ai frame BGRA/rgba16float da canvas WebGPU quando diventano `new VideoFrame(canvas)`: assunto 8-bit BGRA (vedi 1a). Output dei compute shader WebGPU non puo' quindi rientrare nell'encoder a 10-bit nel release.

## 8. Test da eseguire su device (iPhone 17 Pro Max, iOS 27.x)

Da eseguire su una pagina HTTPS (secure context, serve per WebCodecs). Stampare tutto su schermo (`document.body.innerText`) per leggerlo senza Web Inspector, oppure collegare Web Inspector da Mac.

```js
// T0 - Versione/ambiente
const env = { ua: navigator.userAgent, enc: typeof VideoEncoder, dec: typeof VideoDecoder,
  gpu: !!navigator.gpu, vfFormats: null };

// T1 - Supporto encoder HEVC (profili, livelli, bitrate, formati)
const base = { width: 1920, height: 1080, framerate: 60, bitrate: 20_000_000 };
const encCfgs = [
  { codec: 'hvc1.1.6.L123.B0' },                       // Main
  { codec: 'hvc1.2.4.L123.B0' },                       // Main10 (stringa Apple/VT)
  { codec: 'hvc1.2.4.L123.B0', latencyMode: 'quality' },
  { codec: 'hvc1.2.4.L123.B0', latencyMode: 'realtime' },
  { codec: 'hvc1.2.4.L123.B0', hevc: { format: 'hevc' } },
  { codec: 'hvc1.2.4.L123.B0', hevc: { format: 'annexb' } },
  { codec: 'hvc1.2.4.L123.B0', bitrateMode: 'constant' },
  { codec: 'hvc1.2.4.L123.B0', scalabilityMode: 'L1T2' },     // atteso: false
  { codec: 'hvc1.2.4.L123.B0', alpha: 'keep' },                // atteso: false/throw
  { codec: 'hvc1.4.10.L123.B0' },                              // RExt 4:2:2 (atteso false)
  { codec: 'hev1.2.4.L123.B0' },
  { codec: 'hvc1.2.4.L126.B0', width: 3840, height: 2160, bitrate: 50_000_000 },
].map(c => ({ ...base, ...c }));
for (const c of encCfgs) {
  try { const r = await VideoEncoder.isConfigSupported(c);
        console.log('ENC', JSON.stringify(c), '=>', r.supported); }
  catch (e) { console.log('ENC', JSON.stringify(c), 'THROW', e.name, e.message); }
}

// T2 - Decoder: supporto + formato reale dei frame 10-bit
// (usare un chunk keyframe HEVC Main10 HLG dall'IMG_xxxx.mov, con description hvcC estratta dal MP4)
for (const codec of ['hvc1.2.4.L123.B0', 'hev1.2.4.L123.B0', 'hvc1.2.4.L153.B0'])
  console.log('DEC', codec, (await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })).supported);

async function probeDecoded(config, chunks /* EncodedVideoChunk[] */) {
  const out = [];
  const d = new VideoDecoder({ output: f => out.push(f), error: e => console.log('DEC ERR', e.name, e.message) });
  d.configure(config);                              // config.description = hvcC ArrayBuffer
  chunks.forEach(c => d.decode(c)); await d.flush();
  const f = out[0];
  console.log('format', f.format, 'coded', f.codedWidth, f.codedHeight,
    'cs', JSON.stringify({ p: f.colorSpace.primaries, t: f.colorSpace.transfer, m: f.colorSpace.matrix, fr: f.colorSpace.fullRange }));
  // Se format === 'NV12' -> il decoder ha ridotto a 8-bit. Se null -> frame 10-bit nativo. Se 'I420P10' -> #80933 e' dentro.
  try { console.log('allocationSize()', f.allocationSize()); } catch (e) { console.log('allocationSize THROW', e.name, e.message); }
  try { const buf = new Uint8Array(f.allocationSize({ format: 'RGBA' })); await f.copyTo(buf, { format: 'RGBA' }); console.log('copyTo RGBA OK'); }
  catch (e) { console.log('copyTo RGBA FAIL', e.name, e.message); }
  try { const n = new Uint8Array(f.allocationSize()); const l = await f.copyTo(n); console.log('copyTo native OK', JSON.stringify(l)); }
  catch (e) { console.log('copyTo native FAIL', e.name, e.message); }
  out.forEach(x => x.close()); d.close();
}

// T3 - Formati VideoFrame costruibili da buffer (esistenza I420P10 / preference)
for (const [format, bps] of [['I420', 1], ['NV12', 1], ['I420P10', 2], ['I420P12', 2], ['P010', 2]]) {
  try {
    const w = 64, h = 64, size = w * h * bps * 3 / 2;
    const f = new VideoFrame(new Uint8Array(size), { format, codedWidth: w, codedHeight: h, timestamp: 0,
      colorSpace: { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: false } });
    console.log('VF', format, 'OK', f.format, JSON.stringify({ t: f.colorSpace.transfer })); f.close();
  } catch (e) { console.log('VF', format, e.name, e.message); }   // atteso nel release: TypeError per i P10
}

// T4 - Passthrough 10-bit: decode HEVC Main10 -> encode HEVC Main10 senza elaborare; leggere profilo dall'SPS
// In output: decoderConfig.description (hvcC) -> byte [1] = general_profile_space/tier/profile_idc:
function hvccProfile(desc) { const b = new Uint8Array(desc);
  return { profileIdc: b[1] & 0x1f, level: b[12], chromaFormat: b[16] & 3, lumaBits: (b[17] & 7) + 8, chromaBits: (b[18] & 7) + 8 }; }
// Layout hvcC: [0]=version, [1]=space/tier/profile_idc, [2..5]=compat flags, [12]=level_idc, [16]=chroma_format_idc, [17]/[18]=bit depth luma/chroma - 8
async function reencode(frames /* VideoFrame[] da T2 */, cfg) {
  const chunks = []; let desc, meta = [];
  const e = new VideoEncoder({ output: (c, m) => { chunks.push(c); if (m?.decoderConfig) { meta.push(m.decoderConfig); desc = m.decoderConfig.description; } },
                               error: err => console.log('ENC ERR', err.name, err.message) });
  e.configure(cfg);
  frames.forEach((f, i) => e.encode(f, { keyFrame: i === 0 }));
  await e.flush();
  const b = new Uint8Array(desc);
  console.log('hvcC profile_idc', b[1] & 0x1f, 'lumaBits', (b[17] & 7) + 8, 'chromaBits', (b[18] & 7) + 8, 'chroma_format_idc', b[16] & 3);
  console.log('decoderConfig.colorSpace', JSON.stringify(meta[0]?.colorSpace), 'chunks', chunks.length,
    'type0', chunks[0]?.type, 'dur0', chunks[0]?.duration, 'ts', chunks.slice(0, 5).map(c => c.timestamp));
  return { chunks, desc };
}

// T5 - Verifica cosa fa VT col profilo/colore: ripetere T4 con codec 'hvc1.1.6.L123.B0' e 'hvc1.2.4.L123.B0' ->
// se l'hvcC e' uguale in entrambi i casi, il profilo e' deciso solo dal pixel format dell'input.
// Verificare anche VUI (SPS): colour_primaries / transfer_characteristics / matrix_coeffs (9/18/9 per HLG BT.2020).

// T6 - Timing: frame sintetici con timestamp VFR e > 2^32 us
async function timingTest() {
  const out = [];
  const e = new VideoEncoder({ output: c => out.push({ ts: c.timestamp, dur: c.duration, t: c.type }), error: x => console.log('ERR', x.message) });
  e.configure({ codec: 'hvc1.1.6.L123.B0', width: 640, height: 360, bitrate: 2_000_000 });
  const cv = new OffscreenCanvas(640, 360), g = cv.getContext('2d');
  const base = 4_294_967_296 - 50_000;                          // a cavallo di 2^32 us
  const ts = [0, 16667, 33333, 50000, 83333, 100000, base, base + 33333, base + 100000].sort((a, b) => a - b);
  for (const t of ts) { g.fillStyle = `hsl(${t % 360},80%,50%)`; g.fillRect(0, 0, 640, 360);
    const f = new VideoFrame(cv, { timestamp: t, duration: 16667 }); e.encode(f); f.close(); }
  await e.flush(); console.log('IN ', ts.join(',')); console.log('OUT', out.map(o => `${o.ts}/${o.dur}/${o.t}`).join(' '));
}

// T7 - Riconfigurazione a meta' stream (rate-only vs altro): contare keyframe e cambi di decoderConfig
async function reconfigTest() {
  const log = [];
  const e = new VideoEncoder({ output: (c, m) => log.push({ ts: c.timestamp, type: c.type, newCfg: !!m?.decoderConfig }), error: x => console.log('ERR', x.message) });
  const cfg = { codec: 'hvc1.1.6.L123.B0', width: 1280, height: 720, bitrate: 4_000_000, framerate: 30 };
  e.configure(cfg);
  const cv = new OffscreenCanvas(1280, 720), g = cv.getContext('2d');
  const feed = async (from, n) => { for (let i = from; i < from + n; i++) { g.fillStyle = `hsl(${i * 7 % 360},70%,50%)`; g.fillRect(0, 0, 1280, 720);
    const f = new VideoFrame(cv, { timestamp: i * 33333 }); e.encode(f); f.close(); } };
  await feed(0, 30);
  e.configure({ ...cfg, bitrate: 1_000_000 });                          // solo rate
  await feed(30, 30);
  e.configure({ ...cfg, bitrate: 1_000_000, latencyMode: 'realtime' }); // cambia altro -> nuova sessione
  await feed(60, 30);
  await e.flush();
  console.log(log.filter(l => l.type === 'key' || l.newCfg));            // attesi: key @0; nessuno @30; key+newCfg @60
}

// T8 - WebGPU external texture da VideoFrame 10-bit (frame da T2): leggere un pixel e confrontare con valore atteso
// 1) device = await (await navigator.gpu.requestAdapter()).requestDevice();
// 2) const ext = device.importExternalTexture({ source: frame, colorSpace: 'srgb' });
// 3) shader: textureLoad(ext, vec2u(x,y)) su un texture_external, scrivere in storage buffer f32.
// Test discriminante: scrivere frame con rampa 10-bit (1023 livelli) e contare i valori distinti del canale G letti
// (>256 => precisione >8 bit mantenuta). Ripetere con colorSpace 'display-p3' per verificare che sia ignorato.
// Ripetere anche con VideoFrame da `new VideoFrame(canvas)` per confermare il passaggio a 8-bit.
```

## 9. Implicazioni per il progetto

1. **Su iOS 27.0-27.2 (build 20625.x) la ricodifica 10-bit HLG con elaborazione GPU NON e' realizzabile via WebCodecs**: (a) non esiste modo di costruire un `VideoFrame` 10-bit (nessun `I420P10`, nessun P010; #75520 solo flag spento e non implementato, #80933 aperto); (b) i frame prodotti da canvas/WebGPU sono 8-bit BGRA e vengono convertiti in NV12 8-bit prima di VT; (c) il decoder rilasciato richiede NV12 8-bit e probabilmente degrada gia' il Main10 all'ingresso (T2 lo conferma/smentisce). Decisione da prendere dopo T2/T3/T4.
2. Scenari sul device, in ordine di fattibilita': **A)** se T2 mostra `format:null` (decoder 10-bit nativo, es. 27.3) -> pipeline "decode -> `importExternalTexture(VideoFrame)` in WebGPU a precisione 10-bit (YCbCr10 mapping)" funziona per *analisi/misura* (metriche percettive) ma il risultato non puo' tornare all'encoder a 10-bit; **B)** passthrough nativo decode->encode senza JS (solo re-quantizzazione di bitrate, nessuna elaborazione pixel); **C)** ricodifica a 8-bit Main (SDR o HLG 8-bit con banding) con elaborazione WebGPU -> canvas -> `VideoFrame(canvas)`; **D)** fallback WASM (x265/ffmpeg.wasm) per il percorso 10-bit con elaborazione, a costo di velocita' (1080p60 su iPhone: ordini di grandezza piu' lenti; solo per segmenti piccoli/test).
3. L'encoder HEVC di Safari e' un **encoder HW VT quasi "cieco"**: unico controllo e' `bitrate` (media, con adjuster che puo' ridurla del 5-50%); niente CRF/quantizer, niente `DataRateLimits`, niente B-frame, niente `ProfileLevel` -> il bitrate target va calibrato per segmento (ricodifica adattiva iterativa: encode, misurare dimensione output, correggere `bitrate` via `configure()` rate-only, che e' economico e non genera keyframe).
4. Il profilo di output e' deciso dal pixel format in ingresso, non dal codec string: validare **sempre** `hvcC` byte (profile_idc, bit depth) nell'output di T4 prima di assumere Main10. Usare `hvc1.` e formato `hevc` (default) -> `description` hvcC pronto per `mp4box/mediabunny`; non usare `hevc.format:'annexb'` (ignorato nel release).
5. Timestamp/duration: non fidarsi di `chunk.duration` (HEVC, release) ne' di timestamp oltre 71,6 min (troncamento a 32 bit nel wrapper libwebrtc, da confermare con T6); tenere una mappa lato app (indice di output = indice di input, niente reorder) e ricostruire dts/pts/duration nel muxer.
6. `main` contiene (non spedito, non verificabile in 27.3 beta) encoder VT diretto con ColorPrimaries/Transfer/Matrix, duration propagata, `hevc.format`, `I420P10` dietro flag, `copyTo`->RGBA con colorSpace: **pianificare feature detection a runtime** (`isConfigSupported`, `new VideoFrame(..., {format:'I420P10'})` in try/catch, `frame.format`) e mantenere i percorsi A-D selezionabili; ricontrollare dopo il rilascio di Safari 27.3 / 28 (nuovi branch `safari-7626*`).
7. Chiave di riconfigurazione: bitrate per segmento -> `configure()` rate-only (stessa sessione, stesso hvcC, nessun IDR). Per cambio risoluzione/latencyMode -> nuova sessione, nuovo `hvcC`: gestire sample entries multiple o re-iniziare un nuovo MP4/segmento.
8. WebGPU: `importExternalTexture(VideoFrame)` e' il percorso zero-copy corretto e mantiene i 10 bit nel campionamento (formato Metal YCBCR10), ma restituisce RGB nel transfer **originale** (nessun HLG->lineare, nessuna gamut conversion, `colorSpace` ignorato): l'inversa HLG OETF/EOTF, BT.2020->BT.709/P3 e il tone-mapping vanno scritti nello shader. Le matrici BT.2020 NCL (Video range) sono gia' applicate da WebKit; verificare con T8 che l'attachment matrix del frame sia `bt2020` (se manca, WebKit assume BT.709 -> colori sbagliati).

## 10. RISULTATI MISURATI SU DEVICE (iPhone 17 Pro Max, Safari 27.0.1) ✅ — run 1
- WebGPU ✅, Wake Lock ✅, OPFS ✅.
- `bitrateMode:'quantizer'` → **TypeError** (enum assente) su tutti i codec. Altre opzioni → `supported:true` (non prova che siano rispettate).
- `isConfigSupported` encode **AV1 8/10-bit = true** (❓ da verificare con encode reale → test t4).
- Encode HEVC 1080p da OffscreenCanvas: **163 fps**; keyFrame forzato rispettato (idx 0, 90); `configure()` bitrate a metà (frame 60) → **nessun keyframe**, bitrate medio 4.57 Mbps (8→3 Mbps: cambio efficace); `chunk.duration` **sempre 0** → durate gestite dal muxer; timestamp preservati; decoderConfig colorSpace da canvas = bt709/sRGB **fullRange:true** (attenzione: forzare range limitato).
- Frame da `<video>` (IMG HLG): `format:null`, colorSpace bt2020/hlg/bt2020-ncl fullRange:true (❓ sospetto), rotazione già applicata (1080×1920), `copyTo` → "VideoFrame has no format"; `importExternalTexture` OK; feature GPU: shader-f16, float16/32-renderable, rg11b10ufloat-renderable.
- In attesa: t4 (encode frame nativo → Main10/HLG? AV1 reale? fps).
- **Run 2 (t4)**: encode del frame nativo HLG → `hvc1.2.4` e `hvc1.1.6` producono output **identico byte-per-byte** (853769 B, desc 122 B) → codec string ignorata (conferma PR #81076); colorSpace riportato bt709/sRGB (forse placeholder) → serve leggere hvcC (profilo/bit depth) = test run 3. **AV1**: 1910 B per 30 frame a ~430 fps → **non è un encoding reale** del frame nativo (probabile frame vuoto: l'encoder SW non legge frame format:null). Run 3 prova AV1 da canvas.
- **Run 3 ✅ DECISIVO**: frame nativo (`<video>` → VideoFrame, format null) → encoder HEVC produce **hvcC profileIdc=2 (Main10), level 120 (4.0), 4:2:0, bitDepth 10/10** indipendentemente dal codec string. ⇒ **Percorso HDR 10-bit esiste**: frame nativo → VideoEncoder (no GPU nel mezzo). ❓ resta da verificare che la VUI della SPS dichiari HLG/BT.2020 (parsing SPS, prossimo test).
- **AV1 reale solo da canvas**: 30 frame 1080×1920 = 686 KB (~11 Mbps vs target 8 → overshoot), **87 fps** → encoder AV1 funzionante, 8-bit (input canvas). Dal frame nativo produce output vuoto. ❓ HW o SW; ❓ qualità vs HEVC.
- **Conseguenza architetturale**: due percorsi possibili —
  - **A (HDR preservato)**: frame nativo → HEVC Main10. Niente pre-filtro pixel GPU. Leve: bitrate per scena, keyframe a scene-cut, GOP lungo, drop frame quasi-duplicati (VFR), audio. 
  - **B (pre-filtro GPU)**: WebGPU → canvas 8-bit → HEVC 8-bit o AV1 8-bit; HDR → tone-map SDR (o HLG 8-bit, rischio banding).
  - ❓ Da testare: canvas WebGPU rgba16float + toneMapping 'extended' / colorSpace HDR → VideoFrame → encoder esce 10-bit? Se sì, A+B si fondono.
- **Run 4 ✅**: canvas WebGPU `rgba16float` (sia extended/display-p3 sia srgb) → VideoFrame **BGRA 8-bit** → HEVC **Main 8-bit**. ⇒ **GPU-filtri e 10-bit NON fondibili** in Safari 27.0.1. Re-decode del Main10 con `VideoDecoder` → **NV12 8-bit**, colorSpace bt709/sRGB (il decoder WebCodecs riduce a 8-bit; non informativo sulla VUI). ⇒ Decodifica 10-bit solo via `<video>` (frame nativi format:null). **Rischio nuovo R10**: `<video>` è un player, può saltare frame → test t6b (frame-exactness a playbackRate 1/2/4) + t6a (hvcC completo per parsing VUI offline).
- **Run 5 ✅**: (a) hvcC completo dell'encoder nativo Main10 parsato offline: SPS 1088×1920 (crop conformance → 1080), 10/10 bit, scaling lists on, SAO on, 4 st-RPS, **`vui_parameters_present_flag = 0` → NESSUNA colour description (né BT.2020 né HLG) nel bitstream**; prefix SEI type 148 (ambient viewing environment, 8 B). ⇒ Obbligatorio: box `colr` nclx (9/18/9) nel container + **riscrittura SPS in hvcC con VUI** (patch bit-level in JS, solo parameter set). (b) `<video>` + rVFC su IMG_2147 (231 frame): 1× → 161 frame unici (~70 %), 2× → 91, 4× → 54 ⇒ **decodifica via playback NON frame-exact (R10 confermato)**. `getVideoPlaybackQuality` restituisce 0/0 (inutile). Run 6: playback 0.25×/0.5× e seek-stepping.
- **Run 6 (parziale)**: IMG_2147 ha **211 frame presentabili** (edit list; 231 pacchetti). Playback+rVFC: 1× 156 (74 %), 2× 96, 4× 52, **0.5× 188 (89 %)**, **0.25× 183 (87 %)** ⇒ nemmeno il playback lento è frame-exact. seekStep: risultato non ancora raccolto. Se anche seekStep < 211 → decodifica 10-bit frame-exact richiede decoder HEVC WASM (valutare costo) oppure accettare 8-bit via VideoDecoder (NV12).
- **Run 6 completo**: seekStep (passo 1/120 s, rVFC + timeout 300 ms) → **208/211 frame unici** (≈ frame-exact; i mancanti dovuti al passo fisso — con timestamp esatti dal demuxer → 211). Velocità non misurabile (tutti i 424 seek hanno colpito il timeout → 75 s, limite superiore). ⇒ **Unica via 10-bit frame-exact: seek per timestamp su `<video>`** (WASM decoder escluso: senza VideoFrame I420P10 costruibili non si può alimentare l'encoder a 10-bit). Run 7 (t8): latenza seek con evento `seeked`.
- **Run 7–8 ⚠️**: t8 seek+'seeked'+VideoFrame(video): 4–5 ms/frame, ~192 fps, frame null|hlg — MA t9 (fingerprint GPU 32×32 su 211 seek) → **1 solo hash distinto** ⇒ sospetto: dopo 'seeked' `new VideoFrame(video)` restituisce un frame stantio (o fingerprint GPU rotto). Le "190 fps" di t8 NON sono affidabili. Run 9 (t10): fingerprint 2D indipendente, attesa 'seeked' vs 'seeked'+rVFC, latenza reale.
