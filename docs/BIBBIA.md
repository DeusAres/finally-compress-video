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

> Dettagli: `research/02-webkit-webcodecs.md`. **Le misure su device (§10 di 02, Safari 27.0.1) prevalgono sulle deduzioni dal codice.**

- ✅ Release 27.0–27.2 (build 20625.x): `VideoEncoder` HEVC = wrapper libwebrtc `RTCVideoEncoderH265` → VT **RealTime**, `AllowFrameReordering=false` (**no B-frame**), solo `AverageBitRate` (+ `BitrateAdjuster` .5/.95: il bitrate reale può scendere sotto il target), `MaxKeyFrameInterval` fisso 7200 frame/240 s. VT diretto + `ColorPrimaries/Transfer/Matrix` esiste solo su WebKit `main` (non spedito).
- ✅ Opzioni ignorate: `bitrateMode` (sempre ABR), `framerate`, `contentHint`, `hevc.format` (output sempre `hvcC`, annexb ignorato, bug 281945), `scalabilityMode` ≠ L1T1, `alpha:keep` → NotSupportedError. ✅ misurato: `bitrateMode:'quantizer'` → **TypeError**; `hevc.quantizer` non esiste.
- ✅ Misurato: **codec string ignorata** (`hvc1.2.4` e `hvc1.1.6` → output identico byte-per-byte); il profilo è deciso dal pixel format dell'input → leggere sempre `hvcC` dell'output.
- ✅ Misurato: `keyFrame:true` per-frame **rispettato**; `configure()` con solo bitrate cambia **al volo, senza keyframe** (8→3 Mbps efficace); altro campo (size/latencyMode…) = nuova sessione, nuovo `hvcC`, IDR implicito.
- ✅ Misurato: `chunk.duration` **sempre 0** → durate dal muxer/mappa app; timestamp preservati (🟡 troncati a 32 bit oltre ~71,6 min, da confermare); `latencyMode` "quality" per offline.
- ✅ Velocità misurate: HEVC 1080p da OffscreenCanvas **163 fps** (nel brief ~170–210 fps), AV1 da canvas 87 fps; WebGPU, Wake Lock, OPFS presenti.
- ✅ Misurato: frame da `<video>` HLG = `format:null` (10-bit nativo), colorSpace bt2020/hlg/bt2020-ncl, rotazione già applicata (1080×1920), `copyTo` → "VideoFrame has no format"; `importExternalTexture` OK (WebGPU mantiene 10-bit nel campionamento, ma `colorSpace` ignorato: nessuna conversione HLG/gamut, solo YCbCr→RGB).
- ✅ Nessun `VideoFrame` 10-bit costruibile da JS (`I420P10` dietro flag spento / PR #80933 aperta); frame da canvas/WebGPU = 8-bit NV12 prima di VT. Colorspace da canvas riportato bt709/sRGB **fullRange:true** (forzare range limitato).
- ✅ AV1: `isConfigSupported` true ovunque, ma encode reale **solo da canvas 8-bit** (~11 Mbps vs target 8: overshoot); dal frame nativo output vuoto. ❓ HW/SW e qualità vs HEVC.
- ✅ Bug/quirk: 262950 (HEVC decode "Decoder failure" su certi file), VT può emettere più NAL per sample (non assumere 1 NAL/chunk); decoder rilasciato 8-bit era solo una deduzione dal codice → **smentita dal device** (vedi §5).
- **Strategia**: feature detection a runtime (`isConfigSupported`, `frame.format`, try/catch su `I420P10`) e ricontrollo dopo Safari 27.3/28 (branch `safari-7626*` non pubblico).


## 3. Memoria su iOS Safari: limiti, crash, strategie

> Dettagli: `research/03-memoria-ios.md`.

- ✅ Soft limit WebContent ~**1.5 GB** (bug 277848, "soft": superabile con poca pressione); 🟡 osservati ~2–3 GB su iPhone 15 Pro; ❓ nessun dato per iPhone 17 Pro Max / iOS 27 → misurare. Superato = jetsam, la pagina si ricarica.
- ❓ Se IOSurface/texture WebGPU/VideoFrame contano nel footprint WebContent o nel GPU process; PWA standalone vs tab: nessuna differenza documentata.
- 🟡 WASM: `memory.grow` non restituisce mai; picchi di compilazione alti (bug 304810) → un solo modulo, memoria massima fissa, niente Asyncify.
- ✅ Nessun `performance.memory`/`deviceMemory`/evento memory-pressure in Safari → budget fisso + rilevamento kill via flag `jobRunning` al reload.
- ✅ **Regole anti-crash**: footprint target ≤ 700 MB; ≤4 VideoFrame decodificati in volo, `decodeQueueSize` ≤8, `encodeQueueSize` ≤4 (backpressure su `dequeue`); `close()` di ogni frame (try/finally), mai array di frame; pool fisso 2–3 texture WebGPU con `destroy()`.
- ✅ I/O: input a chunk 4–16 MB con `Blob.slice()`/`stream()` (🟡 File da Libreria Foto può essere transcodificato; `WebkitBlobResource error` dopo ~60 s → copiare subito in OPFS); output in OPFS con `createSyncAccessHandle` in Worker (buffer 1–4 MB, `flush()` ogni 5–10 s), mai Blob/array in RAM.
- ✅ Quota OPFS (Safari 17+): fino al 60 % del disco per origine browser, stessa quota per PWA; `persist()` non garantito; richiedere spazio ≥ 2.5× input; gestire `QuotaExceededError`.
- 🟡 Consegna: `navigator.share({files})` con user activation + `canShare`; file grandi problematici (>~1 GB), fallback "Salva in File"/`<a download>`; ❓ "Salva video" → Foto da testare.
- 🟡 Ciclo di vita: JS sospeso in background → checkpoint ogni ~10 s/GOP su OPFS (offset input, ultimo keyframe, byte scritti), ripartenza dal keyframe; assumere `device.lost` e codec da ricreare.
- ✅ Wake Lock: in PWA standalone solo da iOS 18.4, va ri-richiesto su `visibilitychange` (misurato: disponibile su Safari 27.0.1); UI "tieni aperta l'app".
- Rilevamento reload: dimezzare i budget dopo un kill (flag in localStorage/OPFS); telemetria locale dei picchi.


## 4. Container: demux / mux / metadati / audio

> Dettagli: `research/04-container-metadati.md` (Mediabunny 1.66, mp4box.js 2.5.0).

- ✅ Demux Mediabunny: `hvc1` Main10, `colr` (`getColorSpace()`, `hasHighDynamicRange()`), rotazione (`track.rotation`), VFR (`stts`/`ctts`), tag `mdta` in `getMetadataTags().raw`. ❌ Non espone `dvcC/dvvC`, `amve`, `mdcv`, `clli`; tracce `mebx` scartate; `apac` compare con `codec === null`.
- ✅ Mux: `MovOutputFormat` (colr `nclc`, come iPhone) preferibile a MP4; HEVC sempre `hvc1` + `hvcC` + `colr` solo se l'encoder restituisce `decoderConfig.colorSpace` (🟡 ❓ in Safari il colorSpace può essere placeholder → verificare/patchare 9/18/9). Rotazione via `addVideoTrack(..., {rotation})`, non sui pixel; VFR e B-frame ok.
- ✅ `fastStart:false` (moov in coda, come i sorgenti) + `StreamTarget` su OPFS (`chunked:true`): RAM minima. ❌ `'in-memory'` = RAM pari al file; `'fragmented'` scartato (supporto Foto incerto).
- ✅ Tag: Mediabunny scrive `mdta` in `moov/udta/meta`, non in `moov/meta` come iPhone → 🟡 Foto potrebbe ignorarli (data/posizione) ❓. Soluzione: post-processing del moov a mano (fattibile ✅ perché moov in coda: niente rewrite di `stco`).
- ✅ Post-processing: `moov/meta` (hdlr mdta + keys + ilst) con `creationdate` **con fuso** (`+0100`), `location.ISO6709`, `make/model/software`; fallback `udta/©xyz`; copiare dal sorgente `amve` (TN3145: senza, luminosità errata), `mdcv`, `clli`; patch `colr` 9/18/9.
- ✅ Dolby Vision: rimuovere `dvcC/dvvC` (Mediabunny non li scrive); dichiarare HLG puro `hvc1` + `colr` 9/18/9 + `amve`; RPU non rigenerabile da WebCodecs. 🟡 Atteso badge HDR, non DV (❓ da confermare in Foto).
- ✅ Audio: `apac` (spaziale, decoder da iOS 17) **non scrivibile** da Mediabunny né presente nei codec WebCodecs; passthrough manuale possibile ma costoso/rischioso (stco, track_id, alternate_group). **Proposta v1: scartare `apac` e `mebx`, passthrough AAC-LC** (`EncodedPacketSink` → `EncodedAudioPacketSource('aac')`); informare l'utente della perdita dello spaziale; ❓ sync/priming AAC.
- ✅ `Conversion` ad alto livello: rischio re-render su canvas (8-bit) → usare pipeline manuale `VideoSampleSink` → `VideoSampleSource`; mp4box.js solo ispezione (bufferizza tutto in RAM, niente `apac`/`mebx`/`dvvC`).
- Raccomandazione sintetica: pipeline manuale + MOV + moov in coda + AAC passthrough + post-patch moov (box layout in 04 §3).


## 5. HDR, HLG, Dolby Vision

> Dettagli: `research/02` §3/§10, `research/04` §4/§6.

- ✅ Sorgente: HEVC Main10, BT.2020/HLG (arib-std-b67), DV profilo 8.4 (base layer HLG valido; RPU nel bitstream), `amve` presente.
- ✅ **Misurato (run 3, decisivo)**: frame nativo da `<video>` (`format:null`, 10-bit) → `VideoEncoder` HEVC produce `hvcC` **profileIdc=2 (Main10), level 120, 4:2:0, bitDepth 10/10**, indipendentemente dalla codec string → **percorso HDR 10-bit esiste, ma senza GPU nel mezzo**. (Contraddice la deduzione dal codice che il decoder rilasciato fosse 8-bit NV12.)
- ✅ Frame da canvas/WebGPU (`new VideoFrame(canvas)`) = 8-bit → Main 8-bit; nessun `VideoFrame` 10-bit costruibile da JS; `copyTo` non utilizzabile su `format:null`.
- **Percorso A (HDR preservato)**: frame nativo → HEVC Main10, nessun pre-filtro pixel; leve = bitrate per scena, keyframe a scene-cut, GOP lungo, drop frame quasi-duplicati, audio.
- **Percorso B (pre-filtro GPU)**: WebGPU → canvas 8-bit → HEVC/AV1 8-bit; HDR → tone-map SDR (o HLG 8-bit, rischio banding).
- ❓ Da testare: canvas WebGPU `rgba16float` + `toneMapping:'extended'`/colorSpace HDR → VideoFrame → encoder 10-bit? Se sì A+B si fondono. ❓ VUI dell'SPS (9/18/9?) e `colorSpace` riportato dall'encoder (bt709/sRGB è forse placeholder) → parsing SPS.
- ✅ WebGPU `importExternalTexture(VideoFrame)` mantiene 10-bit (YCBCR10) ma restituisce RGB nel transfer originale: inversa HLG, gamut BT.2020→709/P3 e tone-mapping vanno scritti in shader (utile per analisi/metriche, non per rientrare nell'encoder a 10-bit).
- 🟡 Output HLG: `hvc1` + `colr` 9/18/9 + `amve`, senza `dvvC` (file dichiarato HLG puro); Foto mostra HDR (non DV) ❓.
- ✅ Prior art: tutti vanno a SDR 8-bit via `drawImage` su canvas, tone-mapping non misurata (vedi §9); un `colorSpace` HDR ricevuto dal decoder può essere forzato via `VideoDecoderConfig.colorSpace` (release notes 27.0).
- Decisione aperta: percorso A vs B vs test canvas HDR float16 (vedi §10, T4).


## 6. Algoritmi percettivi (pre-encoder)

→ vedi research/06 (fonti verificate 2026-11-18) e research/07. Sintesi metrica: in-loop proxy WGSL (Y-FUNQUE+ o MS-SSIM su HLG), 8–12 frame stratificati/scena, media + 5° percentile, clip di prova contiguo; offline HDR-VMAF v1.1.8 + ColorVideoVDP standard_hdr_hlg + SSIMULACRA2. VMAF WASM (ffvmaf) poco maturo; nessun port WebGPU di VMAF.


## 7. Metriche di qualità eseguibili sulla GPU del telefono

→ vedi research/06 (fonti verificate 2026-11-18) e research/07. Sintesi metrica: in-loop proxy WGSL (Y-FUNQUE+ o MS-SSIM su HLG), 8–12 frame stratificati/scena, media + 5° percentile, clip di prova contiguo; offline HDR-VMAF v1.1.8 + ColorVideoVDP standard_hdr_hlg + SSIMULACRA2. VMAF WASM (ffvmaf) poco maturo; nessun port WebGPU di VMAF.


## 8. Controllo dell'encoder: rate control, GOP, ricerca a circuito chiuso

> Dettagli: `research/02` §2/§4/§10, `research/05`, `research/09` lezioni 4/14.

- ✅ **Unica leva di qualità = `bitrate`** (ABR di VT, media): niente CRF/quantizer (TypeError), `DataRateLimits`, `MaxQP`, B-frame, ProfileLevel. Il `BitrateAdjuster` può portare il reale fino al 50 % del target → misurare sempre la dimensione prodotta.
- ✅ **Ricerca a circuito chiuso su segmenti**: encode → misura byte reali (+ qualità) → correzione bitrate con `configure({...cfg, bitrate})`, che cambia al volo **senza keyframe e senza nuovo `hvcC`** (misurato). 🟡 convergenza non istantanea (adjuster, cambio ogni ≥1 s/30 frame); prior art (Cole) riconfigura solo se delta ≥ 8 % e ≥ 15 frame, ai keyframe.
- ✅ **GOP**: `keyFrame:true` per-frame rispettato (misurato) → keyframe a scene-cut e GOP lungo gestiti da noi; periodico fisso 7200 frame/240 s non regolabile. 🟡 prior art forza IDR sul primo frame e ogni 2 s (costo 2–3 %); misurato: keyFrame su idx 0 e 90 come richiesto; ❓ valido anche Main10.
- ✅ Proxy x265 (05): GOP lungo ≈ **6–10 % di bitrate** a pari qualità; SSIM-Y 0.95 a ~9–10 Mbps (≈ −50/55 % vs 20.4 Mbps) con x265 faster; VT HW è meno efficiente → margine stretto, serve combinare leve (per-scena, GOP, pre-filtro). ❓ VMAF da ottenere.
- ✅ Il denoise è penalizzato dalle metriche full-reference (−0.001 SSIM) → serve metrica vs sorgente filtrata + verifica visiva (cfr. 06, in revisione).
- ✅ Cambi di width/height/latencyMode/colorspace = nuova sessione, nuovo `hvcC`, IDR: evitarli entro un file con una sola sample entry (altrimenti N sample entries/re-mux).
- ✅ Timing: timestamp preservati, `chunk.duration=0` → mappa (timestamp, durata) lato app; VFR ok (nessun reorder); 🟡 wrap a 32 bit dopo ~71,6 min.
- ✅ Throughput misurato ~163 fps (HEVC canvas) / 87 fps (AV1 canvas): una ricerca multi-passata su campioni di scena è fattibile; un solo encoder HW → niente parallelismo (benchmark 1 vs 2, soglia 1.3×) e stall watchdog (5 s).
- ✅ Input per l'allocazione: complessità per scena, keyframe a scene-cut; metriche in 06/07 (in revisione).
- ❓ AV1 8-bit da canvas come alternativa di efficienza (overshoot ~11 vs 8 Mbps target; HW/SW ignoto).


## 9. Prior art su GitHub e nel web

> Dettagli: `research/09-prior-art.md`.

- ✅ **Unico concorrente diretto: `kimymt/iphone-video-compressor`** (PWA iOS 26, mediabunny): HEVC **Main 8-bit** (`hvc1.1.*`, livello da risoluzione/fps), bitrate fisso per preset, HDR→SDR via `drawImage` su canvas (tone-mapping non misurata), keyframe forzato primo frame + ogni 2 s, backpressure (HEVC 4 in volo), audio AAC passthrough (soglia 85 %), `fastStart:'in-memory'` (RAM = file; share >1 GB → `<a download>`), parallelismo con benchmark, 34 pitfall Safari.
- ✅ Pitfall riusabili: user activation sincrona (niente `await` prima di `input.click()`, Wake Lock nel click), un solo `AudioContext`, share di handle OPFS lazy → copiare prima, riserva 2.5× spazio, cleanup su errore, tag `hvc1` obbligatorio, rotazione non applicata dal decoder (nei nostri frame nativi misurata già applicata).
- ✅ Altri: `WebCompress` (dispatcher WebCodecs/ffmpeg.wasm), `donttouchmyvid` (estrazione `hvcC/avcC`, bufferizza tutto), `kaixinol` (Conversion + stall watchdog 5 s, HDR solo etichettato), `ColeSwinford` (allocazione per segmento con riconfigurazione ai keyframe, blur saliency WebGL2, H.264 CBR, mismatch fullRange).
- 🟡 Strumenti/idee: `ab-av1` (crf-search → target quality), `alice-1` (probe corta + feature → parametro, VMAF), `viser` (convex hull per-shot), `ffvmaf` (VMAF WASM, peso/velocità su iPhone ❓), Remotion/mediabunny `webcodecs-bugs` (Safari: AAC primi 1024 sample silenti, bug 328491 aperto), `sb2702/webcodecs-fundamentals` (dataset supporto codec).
- ✅ Mediabunny = standard di fatto (demux robusto MOV iPhone, `StreamTarget` OPFS, `hvc1`); mp4box.js solo parsing.
- ✅ **Spazio libero (nostra innovazione)**: output HEVC Main10/HDR su iOS; tone-mapping controllata e misurata; pre-filtri percettivi WebGPU con metrica; target-quality in-browser; allocazione per scena HEVC VBR con verifica; file grandi senza RAM; pipeline zero-copy `importExternalTexture`; benchmark qualità su iPhone reale.


## 10. Rischi, incognite e test da fare su device

> Test unificati e deduplicati da 02/03/04. Codice dei test T0–T8 in `research/02` §8. Esecuzione: pagina diagnostica HTTPS, output a schermo.

**Già eseguiti (iPhone 17 Pro Max, Safari 27.0.1) ✅**
| ID | Esito |
|---|---|
| T-run1 | WebGPU/WakeLock/OPFS ✅; `quantizer` TypeError; HEVC 1080p canvas 163 fps; keyFrame rispettato; `configure()` bitrate senza keyframe; `chunk.duration`=0; frame `<video>` HLG `format:null`, `copyTo` fallisce, `importExternalTexture` OK |
| T-run2 | `hvc1.2.4` ≡ `hvc1.1.6` byte-per-byte (codec string ignorata); AV1 dal frame nativo = output vuoto |
| T-run3 | Frame nativo → HEVC **Main10, 10/10 bit, 4:2:0** (percorso HDR esiste); AV1 reale solo da canvas 8-bit (87 fps) |

**Rischi principali**: R1 −50 % non raggiunto con VT meno efficiente di x265 (05); R2 jetsam/OOM (limite ~1.5 GB, ❓ 17 Pro Max); R3 metadati/data/posizione ignorati da Foto (`udta/meta`); R4 perdita audio spaziale `apac`; R5 colorSpace/VUI HLG non dichiarato o range sbagliato (full vs limited); R6 sospensione in background; R7 share/salvataggio file grandi; R8 API instabili tra 27.x (feature flag, PR #80933/#81076); R9 bug HEVC decode (262950).

**Test da eseguire (aperti)**
| # | Test | Chiude |
|---|---|---|
| T1 | `isConfigSupported` encoder (Main/Main10, livelli, 4K, latencyMode, scalabilityMode, alpha) e decoder Main10 | 02 T1/T2 |
| T2 | Parsing SPS dell'output: VUI primaries/transfer/matrix (9/18/9), range, `decoderConfig.colorSpace` | R5 |
| T3 | Formati `VideoFrame` costruibili (`I420P10`, `P010`) + `frame.format` decodificato | 02 T3 |
| T4 | Canvas WebGPU `rgba16float` + toneMapping extended → VideoFrame → encoder: 10-bit? (fonde A+B) | §5 |
| T5 | WebGPU `importExternalTexture`: valori distinti >256 (10-bit), `colorSpace` ignorato, matrice bt2020, costo per frame | 02 T8 |
| T6 | Timing: VFR, timestamp >2^32 µs, non monotoni; mappa duration | 02 T6 |
| T7 | Riconfigurazione: rate-only vs altro, convergenza bitrate, frequenza minima di `configure()` | 02 T7 |
| T8 | AV1: HW/SW, qualità vs HEVC, overshoot bitrate; fps con pre-filtro GPU | §8 |
| T9 | Memoria: ArrayBuffer/WASM/texture/VideoFrame fino al reload (tab vs PWA, IOSurface conta?); decoder pool con frame non chiusi; soglie queue 2/4/8/16 | R2 |
| T10 | `<input type=file>` da Libreria Foto vs File: `file.size`, HDR mantenuto, lettura >3 GB e >60 s | 03 |
| T11 | OPFS 1/2/4/8 GB (`createSyncAccessHandle` vs `createWritable`), `estimate()`, `persist()` in PWA | 03 |
| T12 | `navigator.share` 300 MB/1 GB/3 GB: footprint, "Salva video" in Foto, fallback download | R7 |
| T13 | Background/blocco schermo 10 s/60 s/5 min: `device.lost`, codec, ripresa da checkpoint; Wake Lock PWA e `visibilitychange` | R6 |
| T14 | Dump box dei sorgenti (`MP4Box -info`, exiftool) e output Mediabunny (`colr` nclc, `hvc1`, rotazione, `stts`) | 04 |
| T15 | Foto: data/posizione/badge HDR con/senza `moov/meta` patchato, `amve`, fuso, `dvvC`; luminosità HDR vs originale | R3 |
| T16 | Audio: AAC senza `apac` in Foto/AirPods, sync/priming; (opz.) passthrough `apac` | R4 |
| T17 | Mediabunny su iOS: `getColorSpace`, `hasHighDynamicRange`, `rotation`, tag raw, `getTracks()` (apac `codec null`) | 04 |
| T18 | File 1–2 GB end-to-end `fastStart:false` + OPFS: picco RAM, round-trip post-processing moov | R2/R3 |
| T19 | VMAF/VMAF-NEG offline (serve permesso build libvmaf) + clip low-light; VMAF in-app (ffvmaf) su iPhone | R1 |


## 11. Architettura proposta (BOZZA v1 — percorso A validato su device, run 1–9)

**Percorso principale "A — HDR 10-bit preservato"** (unico che preserva HLG; misurato fattibile)
```
.mov (File, streaming)
 ├─ Demux (Mediabunny, solo lettura): timestamp esatti dei frame, scene/keyframe sorgente, AAC, metadati mdta, colr/amve/rotazione
 ├─ Decode 10-bit: <video> + seek al timestamp esatto + evento 'seeked' + new VideoFrame(video)   [t8: 5 ms/frame, ~190 fps, frame nativi HLG]
 ├─ Analisi (WebGPU, 8-bit è sufficiente): scene-cut, complessità, near-duplicate, metrica (FUNQUE+/MS-SSIM)
 ├─ Encode: VideoEncoder HEVC (Main10 automatico da frame nativo) [~200 fps]
 │    · keyFrame solo ai cambi scena (GOP lungo)          · bitrate per scena via configure() al volo (senza keyframe)
 │    · ricerca a circuito chiuso: encode di prova di un campione contiguo per scena → VideoDecoder (NV12) → metrica vs sorgente → bisezione
 │    · drop dei frame quasi-duplicati (VFR) = leva "senza toccare i pixel"
 ├─ Fix bitstream/container: riscrittura SPS in hvcC con VUI (BT.2020/HLG/limited), box colr nclx 9/18/9, copia amve(+mdcv/clli), niente dvcC/dvvC
 ├─ Mux (Mediabunny StreamTarget → OPFS, fastStart:false) + AAC passthrough + metadati mdta in moov/meta (post-processing) + rotazione
 └─ Consegna: share sheet "Salva video" (❓ limite dimensione) 
```
Leve disponibili in A: bitrate per scena, GOP/scene-cut, frame quasi-duplicati, audio. **Niente pre-filtri sui pixel** (passare dalla GPU = 8-bit, run 4).

**Percorso opzionale "B — SDR con pre-filtri percettivi"**: frame → WebGPU (denoise temporale, JND, motion masking, tone-map HLG→SDR) → canvas 8-bit → HEVC Main 8-bit (o AV1 8-bit ~90–100 fps, ❓ qualità). Per utenti che accettano di perdere l'HDR in cambio di più compressione. Da valutare con VMAF in laboratorio.

**Realismo dell'obiettivo −50 % (lab VMAF, x265 faster proxy, research/05)**: IMG_7440 (20.4 Mbps) → VMAF 95 a ~7.5 Mbps = **−63 %**; IMG_2147 (12.6 Mbps) → VMAF 95 stimato a 8–9 Mbps = **solo −30/35 %** (a −54 % VMAF 91.4). ⇒ il risparmio dipende dal bitrate di partenza; VideoToolbox realtime (no B-frame) sarà verosimilmente meno efficiente di x265. Il −50 % a VMAF 95 **non è garantito** per tutti i clip. Il denoise non migliora le metriche FR (atteso). VMAF p5 15–17 punti sotto la media → guidare la ricerca anche sul percentile basso. Prossimo passo lab: rifare con `hdr_vmaf_v1.1.8`.

**Incognite residue da testare prima di costruire**
1. ~~t9~~ ✅ risolto (t10): seek → frame distinti, 5 ms/seek.
2. Foto: import di HEVC Main10 con colr HLG + VUI patchata → badge HDR? metadati data/luogo letti? moov in coda accettato? (contraddizione research/04 vs 09)
3. Primo chunk = IDR (NAL 19/20) e non CRA.
4. Qualità reale del rate control VideoToolbox realtime (no B-frame) vs originale iPhone → quanto bitrate serve per VMAF ≥ 95 (laboratorio non può emulare VT: misurare su device con encode di prova + metrica).
5. Throttling termico su clip lunghi; memoria (budget research/03).

## 12. Diario delle decisioni

- 2026-11-18 — PWA only (no Mac). Codec output: HEVC via WebCodecs. *(Aggiornato: AV1 encode reale ✅ ma solo da canvas 8-bit — vedi research/02 §10.)* Criterio: ≥−50 % e nessuna differenza visibile a schermo intero.
- 2026-11-18 — Subagent: modello Sonnet per ricerca; risultati in `docs/research/`.

---

- 2026-11-18 — Contraddizioni aperte da risolvere con test su device: (a) posizione moov — research/09 (kimymt) dice che Foto richiede moov in testa, research/04 raccomanda moov in coda per RAM → **test: salvare in Foto due file (moov testa/coda) e verificare import + metadati**; (b) "WebKit non emette IDR sul primo frame" (kimymt) vs misura nostra keyFrame idx 0 rispettato → verificare che il chunk 0 sia IDR (NAL type 19/20) e non CRA.

## 13. STATO / RIPRESA (leggere per primo)

**Fase attuale: RICERCA (pre-costruzione). Nessun codice app ancora.**

File di ricerca prodotti (leggerli prima di sintetizzare le sezioni 2–11):
- `research/02-webkit-webcodecs.md` ✅ (letto sorgente WebKit) — **VINCOLO CRITICO**: in Safari 27.0–27.2 l'encoder è il wrapper libwebrtc `RTCVideoEncoderH265` (VT **RealTime**, **no B-frame**, solo AverageBitRate, BitrateAdjuster); bitrateMode/quantizer/framerate/contentHint ignorati; keyFrame per-frame OK; configure() col solo bitrate = cambio al volo senza keyframe. **Niente VideoFrame 10-bit costruibili né copyTo 10-bit**; frame da canvas/WebGPU → NV12 8-bit; decoder release probabilmente 8-bit. VT diretto + 10-bit solo su WebKit `main` (futuro). WebGPU importExternalTexture mantiene 10-bit ma ignora colorSpace. → Nel release: **HDR 10-bit + pre-filtro GPU non fattibile**; opzioni: output 8-bit (SDR tone-mapped o HLG 8-bit ❓), attendere Safari futuro, o encoder WASM. Test device T0–T8 nel file.
- `research/03-memoria-ios.md` ✅ — limite WebContent soft ~1.5 GB (bug 277848), ~2–3 GB osservati; regole anti-crash con budget (frame in volo ≤4, decodeQueue ≤8, encodeQueue ≤4, footprint ≤700 MB); OPFS + createSyncAccessHandle in worker; Wake Lock in PWA da iOS 18.4; share sheet con file grandi problematico.
- `research/04-container-metadati.md` ✅ — Mediabunny 1.66: legge hvc1 Main10/colr/rotazione/VFR/tag mdta; NON scrive apac/mebx; tag mdta in udta/meta (Foto potrebbe ignorarli → post-processing moov/meta); usare fastStart:false + StreamTarget OPFS; pipeline manuale VideoSampleSink→Source (Conversion via canvas rischia 8-bit); copiare `amve` (TN3145) + mdcv/clli; rimuovere dvcC/dvvC; APAC: passthrough non supportato → proposta: scartare, tenere AAC.
- `research/05-esperimenti-proxy.md` ✅ — GOP lungo ≈ 6–10 % bitrate; denoise penalizzato dalle metriche FR; SSIM-Y 0.95 a ~9–10 Mbps (x265 faster) ≈ −50 %. VMAF da ottenere (serve permesso).
- `research/06-algoritmi-percettivi.md` 🟡 — molte citazioni ❓ (subagent con poche ricerche): **da verificare i paper prima di fidarsi dei numeri**. Ranking: per-scena + keyframe a scene-cut > denoise MC > JND in PU21/HLG > guardia banding > motion masking > ROI volti. Metrica in-loop: SSIM/MS-SSIM in PU21 + controllo banding; offline VMAF NEG / ColorVideoVDP.
- `research/09-prior-art.md` ✅ — kimymt/iphone-video-compressor (mediabunny, HEVC Main 8-bit, 34 pitfall Safari: niente IDR automatico, user activation, wake lock, 1 encoder HW, fastStart in-memory = RAM); nessuno fa Main10/HDR, pre-filtri WebGPU con metrica, per-scena HEVC, output grandi senza RAM → nostro spazio.

**AGGIORNAMENTO device (Safari 27.0.1)**: vedi research/02 §10. HEVC Main10 10-bit ✅ da frame nativo; AV1 reale ✅ solo da canvas 8-bit (87 fps); quantizer ✗; keyFrame ✅; bitrate al volo ✅ senza keyframe; chunk.duration=0. Decisione da prendere: percorso A (HDR, no filtri pixel) vs B (filtri GPU, 8-bit) vs test canvas HDR float16.

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
