# 04 - Container, metadati, HDR/Dolby Vision, audio APAC

Legenda: ✅ verificato (fonte/codice letto) · 🟡 parziale / con riserve · ❓ non verificato, da testare su device.
Sorgenti Mediabunny lette direttamente dal repo (v1.66.0, `src/isobmff/*`, `src/conversion.ts`, `src/output-format.ts`); mp4box.js v2.5.0 (repo gpac). Data ricerca: 2026-11-18.

---

## 1. Mediabunny (https://mediabunny.dev, https://github.com/Vanilagy/mediabunny)

### 1.1 Lettura (demux)
- ✅ Legge `.mov`/`.mp4` ISOBMFF, `hvc1` con `hvcC` (codec string da `extractVideoCodecString`, include profilo Main10). `isobmff-demuxer.ts`.
- ✅ `colr` letto (`nclx` e `nclc`): `InputVideoTrack.getColorSpace()` -> `{primaries, transfer, matrix, fullRange}`; `track.hasHighDynamicRange()` esiste (docs: https://mediabunny.dev/guide/reading-media-files). Per iPhone HLG atteso `bt2020 / arib-std-b67 (hlg) / bt2020-ncl`.
- ✅ Rotazione: `tkhd` matrix -> `track.rotation` (0/90/180/270). -90 deg diventa 270.
- ❌ NON espone `dvcC`/`dvvC`, `amve`, `mdcv`, `clli`, `pasp` oltre al PAR: nessun accesso ai box raw del sample entry (grep: zero occorrenze di dvcC/dvvC/amve/mdcv/clli in `src/isobmff`).
- ✅ VFR: `stts`/`ctts` letti per campione; timestamp per-packet esatti. `getPacketStats()` ok.
- ✅ Metadati: legge `moov/meta` con `keys`+`ilst` (mdta) e `moov/udta`; esposti in `getMetadataTags().raw` con chiavi tipo `com.apple.quicktime.creationdate`, `com.apple.quicktime.make`, `...location.ISO6709` (demuxer riga ~3092 gestisce `creationdate`). Valori stringa o `Uint8Array`.
- ✅ Tracce sconosciute: nel demuxer `hdlr` gestisce solo `vide` e `soun`; per qualsiasi altro handler (`meta` => mebx, `tmcd`, `text`) `track.info` resta `null` e la traccia viene scartata (riga ~1087: `track.info !== null`). **Le tracce `mebx` NON sono accessibili** via API.
- 🟡 `apac`: handler `soun` quindi la traccia compare come `InputAudioTrack` con `codec === null` (log "Unsupported audio codec (sample entry type 'apac')"). I packet si possono leggere con `EncodedPacketSink` ma `getDecoderConfig()` e' null. Da testare che `getPacket` funzioni con codec null (❓).
- ✅ Conversion: traccia con codec null -> `discardedTracks` con reason `unknown_source_codec` (conversion.ts `_processAudioTrack`).

### 1.2 Scrittura (mux)
- ✅ Formati: `MovOutputFormat` (ftyp `qt  `, `colr` come `nclc` 3x u16, senza flag full-range) e `Mp4OutputFormat` (`colr` `nclx` con full range bit). `isobmff-boxes.ts::colr`. Per HLG 9/18/9 entrambi ok; per iPhone nativo e' `nclc`, quindi **MOV consigliato**.
- ✅ HEVC scritto sempre come `hvc1` (commento nel sorgente: Apple rifiuta `hev1`) + `hvcC` dal `decoderConfig.description` + `colr` se `decoderConfig.colorSpace` non e' vuoto + `pasp` + `btrt`.
- 🟡 `colr` dipende da `meta.decoderConfig.colorSpace` fornito dall'encoder (`VideoSampleSource`, media-source.ts:~975) o da `VideoEncoderConfig`; Safari potrebbe non restituire `colorSpace` nel metadata -> **verificare** che il `colr` finale sia 9/18/9; altrimenti post-patch del moov (sez. 3). ❓
- ❌ Non scrive: `dvcC/dvvC` (bene: vogliamo rimuoverlo), `amve`, `mdcv`, `clli`. Nessun hook per box extra nel sample entry (`videoSampleDescription` ha lista fissa).
- ✅ Rotazione: `addVideoTrack(source, { rotation: 270 })` o `transformationMatrix` raw -> `tkhd` matrix (`isobmff-boxes.ts` ~484). Valori ammessi 0/90/180/270 (validate riga 688).
- ✅ VFR: ogni sample scrive la propria delta in `stts` (timescale derivato dal frameRate se dato); nessuna costrizione CFR. ✅ B-frame/`ctts` gestiti (decodeTimestamp).
- 🟡 Metadati: `output.setMetadataTags({ raw: { 'com.apple.quicktime.creationdate': '2026-..' , ... } })` con `metadataFormat: 'mdta'` scrive `keys`+`ilst` (UTF-8, type indicator 1, `isobmff-boxes.ts::metaMdta`). **Pero' li mette in `moov/udta/meta`, non in `moov/meta`** come fa iPhone/AVFoundation. Impatto su Foto ❓ (ffmpeg `use_metadata_tags` ha lo stesso problema segnalato: Apple non legge, vedi sez. 4). Con `metadataFormat:'auto'` + MOV scrive solo atomi `udta` (©nam, ©day ecc.), non le chiavi com.apple.quicktime.*.
- ✅ `tags.raw` accetta solo string / Uint8Array / RichImageData: tipi numerici/float (location come stringa ISO6709 ok).
- ❌ Passthrough di codec sconosciuti: `EncodedAudioPacketSource(codec: AudioCodec)` accetta solo codec noti (aac, opus, mp3, flac, ac3, eac3, dts, truehd, pcm*). `audioCodecToBoxName` non ha `apac`. **Non si puo' scrivere una traccia apac ne' mebx** (niente handler `meta`/mebx nel muxer). Confermato dal codice.
- ✅ AAC-LC passthrough: `EncodedPacketSink` -> `EncodedAudioPacketSource('aac')` con `decoderConfig` (description = AudioSpecificConfig); in Conversion con `audio: {}` e codec supportato dal formato fa copia automatica (no transcode) se non ci sono opzioni che forzano il transcode.

### 1.3 Target, fastStart, RAM
- ✅ `StreamTarget(writable, { chunked, chunkSize })` (target.ts): scrive `{type:'write', data, position}`; compatibile con `FileSystemWritableFileStream` (OPFS). `chunked: true` accumula in blocchi (default 16 MiB) e riduce le write.
- ✅ `fastStart`: `false | 'in-memory' | 'reserve' | 'fragmented'` (output-format.ts:181).
  - `false`: moov in coda, RAM minima (solo tabelle sample + piccoli buffer). **Stessa struttura dei .mov sorgente iPhone (moov in coda).**
  - `'in-memory'`: tiene TUTTI i media chunk in RAM fino a finalize -> RAM ~ dimensione file di output. Pericoloso su iOS Safari con file da centinaia di MB/GB (jetsam).
  - `'reserve'`: riserva spazio moov in testa, richiede `maximumPacketCount` per ogni traccia (Conversion lo stima); serve target seekable (StreamTarget con position OK). Se il moov reale supera lo spazio riservato -> errore. RAM bassa.
  - `'fragmented'`: fMP4, scartare: supporto Foto/QuickTime incerto (❓), i docs stessi lo dicono meno supportato.
- ✅ Raccomandazione: `fastStart: false` (moov in coda) + `StreamTarget` su OPFS. Foto/AVFoundation non richiedono faststart per un file locale.
- ❓ Safari iOS: `FileSystemFileHandle.createWritable()` in OPFS (supportato solo da Safari recente; in alternativa worker + `createSyncAccessHandle`, che richiede wrapper WritableStream custom). Da testare su iOS 26.

### 1.4 Conversion API e personalizzazione pipeline
- ✅ `new Conversion({ input, output, video: {...}, audio: {...}, tags })`. Per ogni traccia: copia (passthrough) se nessuna opzione richiede transcode e il codec e' ammesso nel formato di output; altrimenti decode -> (process) -> encode. (`needsTranscode` conversion.ts ~1596).
- ✅ Opzioni video: `codec:'hevc'`, `bitrate`/`quality`, `width/height/fit`, `frameRate`, `keyFrameInterval`, `hardwareAcceleration`, `forceTranscode`, `discard`, `rotate`, `crop`, `process(sample: VideoSample) => VideoSample | CanvasImageSource | null`, `processedWidth/Height`.
- ✅ `tags: (inputTags) => outputTags` consente di partire dai raw tag dell'input e filtrare/aggiungere; **default: copia i tag input** (tranne `creationTime`); se formato in/out diverso (`mimeType`), `raw` viene eliminato (riga ~1175) -> mov->mov li mantiene, mov->mp4 no.
- ✅ Tracce non gestite finiscono in `conversion.discardedTracks` (con `reason`) e `isValid` resta true se resta almeno una traccia.
- ⚠️ Rischio HDR: quando serve "rerender" (resize, crop, rotate con process, PAR non quadrato, **o fallimento del test di un frame HDR sull'encoder**, conversion.ts ~1878-1900) i frame passano per canvas -> tipicamente 8-bit SDR/sRGB => **si perde il 10-bit HLG o si ottiene colore errato** ❓. Se vuoi ridimensionare HDR, valuta pipeline manuale: `VideoSampleSink` -> trasformazione WebGL/WebGPU 10-bit/float (o `VideoFrame` -> `VideoEncoder` con `colorSpace` esplicito) -> `VideoSampleSource` / `EncodedVideoPacketSource`.
- ✅ Pipeline "ibrida" consigliata: usare Conversion solo se basta; altrimenti API low-level: `Input` + `VideoSampleSink`/`EncodedPacketSink`, `Output` + `VideoSampleSource` (encoder interno) e `EncodedAudioPacketSource('aac')` per l'audio passthrough, `addVideoTrack(src, {rotation})`.
- Fonti: https://mediabunny.dev/guide/converting-media-files · https://mediabunny.dev/guide/writing-media-files · https://mediabunny.dev/guide/output-formats · https://mediabunny.dev/guide/media-sources

---

## 2. mp4box.js (https://github.com/gpac/mp4box.js, v2.5.0)
- ✅ Ha parsing e writing: `createFile()`, `addTrack(options)`, `addSample(trackId, data, {dts,cts,duration,is_sync,...})`, `getBuffer()/save()` (scrive TUTTO in un DataStream in RAM: nessuno streaming di file non frammentati -> RAM = file). Non adatto a file grandi su iOS.
- ✅ Box presenti nel registry v2.x: `meta`, `keys`, `ilst`, `qt/data`, `colr`, `amve`, `mdcv`, `clli`, `hvcC`, sample entry `mett/metx`. ❌ Assenti: `dvcC/dvvC` (verra' trattato come box sconosciuto, ma parsing generico lo preserva in lettura), `mebx` (sample entry), `apac`.
- 🟡 `addTrack({hdlr:'meta', type:'mett'...})`, `description_boxes: [...]` permettono di aggiungere box custom al sample entry (utile per `amve`/`colr`), ma `addTrack` costruisce solo entry note nel `BoxRegistry.sampleEntry[type]`; entry sconosciute (`apac`, `mebx`) -> errore/undefined (riga ~2814: `BoxRegistry.sampleEntry[options.type]`). Si dovrebbe registrare una classe custom (possibile ma non documentato) ❓.
- ✅ Per remux "passthrough" di tracce parse -> `getTrackSamplesInfo` / `setExtractionOptions` + `onSamples` danno i byte dei sample; ri-scrivere in un nuovo `ISOFile` con `addSample` e' possibile ma impone di ricreare ogni sample entry. Nessuna copia diretta di `trak` esistenti.
- 🟡 Rotazione: `tkhd.matrix` modificabile manualmente dopo `addTrack` (campo pubblico), non e' un'opzione.
- Verdetto: **utile come parser/ispettore (e per debug dei box), non come muxer principale**. Per post-processing preferire un writer ad-hoc (sez. 3).
- Fonti: https://github.com/gpac/mp4box.js · https://github.com/gpac/mp4box.js/issues/243

---

## 3. Scrivere/patchare box a mano (post-processing del moov)
Fattibilita' ✅ alta **se il file e' `fastStart:false` (moov in coda)**: aggiungere/ridimensionare box dentro `moov` non sposta `mdat` e quindi non richiede di riscrivere `stco/co64`. Procedura: leggere gli ultimi byte (trovare `moov` scorrendo i top-level box con size/largesize), parsare in un albero minimale, modificare, troncare il file all'offset del vecchio moov e riscrivere il nuovo (OPFS: `truncate()` + write; con SyncAccessHandle semplice). Con moov in testa (`reserve`/`in-memory`) ogni aumento di dimensione sposta tutti gli offset (da evitare).

Primitive: `box = u32 size | fourcc | payload` (size include 8 byte; largesize se >4 GiB). Full box = + `u8 version, u24 flags`. Dopo la modifica ricalcolare le size di tutta la catena di antenati.

Struttura minima per i metadati stile iPhone (sotto `moov`, **non** dentro `udta`):
```
moov
 └ meta                         (box semplice, NO version/flags)
    ├ hdlr  (full) pre_defined=0, handler_type='mdta', reserved 12B, name=0 (1 byte)
    ├ keys  (full) entry_count=N; per entry: u32 size(=8+len) | 'mdta' | key utf8
    └ ilst
       └ item i (fourcc = u32 BE indice 1..N, NON testo)
          └ data: u32 type (1=UTF-8, 21=int BE, 23=float32 BE) | u32 locale=0 | valore
```
Chiavi tipiche: `com.apple.quicktime.creationdate` = `2026-11-14T18:32:05+0100` (iPhone usa offset senza due punti; Foto richiede il fuso, vedi sez. 4); `com.apple.quicktime.location.ISO6709` = `+45.4642+009.1900+120.000/`; `com.apple.quicktime.make`, `.model`, `.software`.
Fallback consigliato aggiuntivo: `moov/udta/©xyz` (stringa ISO6709 come fa iPhone, tipo `u16 len | u16 lang | testo`) per compatibilita' con lettori che ignorano mdta.

Aggiungere `amve` / `mdcv` / `clli` a `hvc1`: copiare i byte dei box dal sample entry **sorgente** (parser minimo dell'hvc1: header 78 byte VisualSampleEntry, poi box figli) e appenderli al `hvc1` di output; aggiornare size di `hvc1`, `stsd`, `stbl`, `minf`, `mdia`, `trak`, `moov`. `amve` = `u32 ambient_illuminance | u16 ambient_light_x | u16 ambient_light_y` (box semplice, https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata).
Correggere `colr` in place se Mediabunny non lo ha scritto 9/18/9: `colr`(`nclc`, u16 9, u16 18, u16 9) = 18 byte totali.

Copiare tracce non supportate (`apac`, `mebx`): 🟡 fattibile ma costoso: serve copiare l'intero `trak` dal moov sorgente, **ricalcolare `stco/co64` per i nuovi offset in mdat** e accodare i dati dei sample al `mdat` scritto da Mediabunny (che e' un unico mdat monolitico, header size da riaggiustare, 64-bit se >4 GiB), aggiornare `mvhd.next_track_id`, `tkhd.track_id` univoci, `tref`/`alternate_group`. Alternativa: scrivere tutto con un muxer proprio. Sconsigliato per v1.
Test di sanita': `ffprobe -show_streams`, `mp4dump` (Bento4), `MP4Box -info`, exiftool `-a -G1 -s` su file di output.

---

## 4. Foto di iOS: data, posizione, HDR, audio
- 🟡 Data: Foto/macOS legge nell'ordine `com.apple.quicktime.creationdate` (Keys) -> poi altre date -> data file. Se manca l'offset di fuso (`+0100`) puo' mostrare anni assurdi (Photos 6.0). Fonte: https://exiftool.org/forum/index.php?msg=93534 (Phil Harvey), https://exiftool.org/forum/index.php?msg=62215, https://discussions.apple.com/thread/251736242. Nota: `QuickTime:CreateDate` (mvhd/mdhd) e' UTC senza fuso -> usato come fallback con TZ locale.
- 🟡 Posizione: Foto usa `com.apple.quicktime.location.ISO6709` (Keys) - scritta da iPhone anche in `udta/©xyz`. Segnalazioni di file riscritti (exiftool/ffmpeg) dove Foto non mostra posizione/data: https://exiftool.org/forum/index.php?msg=82811, https://exiftool.org/forum/index.php?msg=64751. Probabile causa: posizionamento/formato (es. mdta in `udta/meta` invece che in `moov/meta`) ❓. https://ffmpeg.org/pipermail/ffmpeg-trac/2018-December/046890.html
- ❓ Se il salvataggio avviene da share sheet (`navigator.share({files})` -> "Salva video") Foto applica la stessa lettura metadati dell'import; non documentato da Apple. **Va testato.**
- 🟡 HDR senza dvcC: Apple documenta HLG come HDR valido: `hvc1`, Main10, `colr` 9/18/9 (https://developer.apple.com/av-foundation/High-Dynamic-Range-Metadata-for-Apple-Devices.pdf, pag. 8). Un ffmpeg re-encode senza DV mostra "HDR" e non "Dolby Vision" su iOS (segnalazione aneddotica: https://gh.r-mj.com/jgorostegui/ios-media-toolkit). Quindi atteso: **badge HDR + playback HDR (HLG)** ma niente DV. ❓ da confermare in Foto.
- ⚠️ `amve` (Ambient Viewing Environment): TN3145 dice che i contenuti HLG/DV 8.4 di iPhone lo contengono e che rimuoverlo "will result in the video not being displayed correctly on Apple devices due to extra bright imagery" -> **copiare `amve` dal sorgente** (sez. 3). https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata
- 🟡 Audio: un MOV con sola traccia AAC-LC stereo si riproduce normalmente ovunque; si perde il rendering spaziale (apac) e le tracce `mebx` (face detection, ecc.) non sono necessarie alla riproduzione. Foto ricalcola i propri analytics. ❓ Verificare che non cambi nulla per Cinematic Mode/Spatial.
- Lettura iOS dei metadati `mebx` per Foto (es. live-photo-info) irrilevante per video normali ✅ (supposizione). **Smentita in parte (v0.33)**: «Mix audio» in Foto richiede quasi certamente la mebx `cinematic-audio` collegata (tref `cdsc`) alla traccia apac → da v0.33 tutte le mebx vengono copiate (sezione in fondo).

---

## 5. Apple Positional Audio Codec (APAC)
- ✅ Codec di Apple per audio spaziale (Ambisonics fino al 3o ordine + channel-based, profili 5 e 31), con renderer adattivo (cuffie head-tracked ecc.). Encoder piattaforma da iOS/macOS 26; **decoder da iOS 17 / macOS 14** (https://developer.apple.com/av-foundation/Apple-Positional-Audio-Codec.pdf). Sample entry MP4/MOV `apac`; iPhone 16/17 registra 4 canali Ambisonics FOA (ffmpeg trac #11480).
- ✅ Non decodificabile con FFmpeg stabile (nessun decoder; esiste una PR in corso "apple_apac", https://mail-archive.com/ffmpeg-devel@ffmpeg.org/msg189385.html; ticket https://ffmpeg.org/pipermail/ffmpeg-trac/2025-February/072812.html); Plex non lo riproduce (https://forums.plex.tv/t/plex-cannot-play-apple-positional-audio-codec-apac-files/941135).
- ✅ WebCodecs: `apac` non e' nel registro dei codec WebCodecs; `AudioDecoder.isConfigSupported` non lo accetta (da confermare con `isConfigSupported({codec:'apac'...})` ❓ ma non esiste una registration W3C).
- 🟡 Decodifica indiretta (non sul percorso consigliato): `AudioContext.decodeAudioData` o `<video>` + `MediaElementAudioSourceNode` su Safari potrebbero usare CoreAudio e rendere stereo/binaurale, ma e' un rendering, non il flusso originale ❓.
- **Unica opzione per preservarlo = passthrough dei pacchetti + `trak`/`stsd` `apac` (con box `dapa`/config) intatti**, impossibile con Mediabunny (sez. 1.2) e rischioso a mano: riproduzione dipende dal decoder del dispositivo; dispositivi < iOS 17 e player terzi muti; Foto potrebbe non riconoscere l'`alternate_group` AAC fallback se mal copiato; peso del file invariato (apac e' piccolo vs video).
- Rischi del passthrough: offset `stco` errati = audio corrotto/crash; sample entry copiata ma `tkhd.alternate_group`/`track_id` in conflitto; Safari puo' rifiutare il file.

---

## 6. Dolby Vision e ricodifica
- ✅ Sorgente: HEVC Main10 + dvvC (Profile 8, cross-compat ID 4 = HLG). Il base layer e' HLG decodificabile da qualunque decoder HEVC; i metadati DV per-frame (RPU) sono **dentro il bitstream** (NAL non specificate), `dvcC/dvvC` nel sample entry dichiara solo la presenza (https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf).
- ✅ Apple stessa dice che se si modificano i pixel i metadati DV diventano invalidi e vanno scartati o rigenerati ("can drop the invalid metadata"). Con AVFoundation export serve `kVTCompressionPropertyKey_HDRMetadataInsertionMode_Auto` per rigenerarli: non disponibile in WebCodecs.
- ⚠️ TN3145 per DV 8.4: `dvvC` shall be present e `amve` present; ma e' un requisito per file *dichiarati* DV. Un file con `dvvC` ma senza RPU nel bitstream = dichiarazione falsa -> comportamenti imprevedibili (tone mapping errato, flicker, rifiuto, riproduzione solo SDR) ❓ nessuna fonte che descriva l'esito esatto.
- ✅ **Raccomandazione: rimuovere dvcC/dvvC** (Mediabunny non lo scrive: gia' ok) e dichiarare HLG puro: `hvc1` + `colr` 9/18/9 + `amve`. Con `hvc1` e non `dvh1`: Apple richiede `hvc1`; `dvh1` solo per DV.
- 🟡 Se si copia accidentalmente il sample entry sorgente (post-processing), **non** copiare `dvvC`; copiare `amve`/`mdcv`/`clli` se presenti.
- ❓ Se la ricodifica WebCodecs scarta le SEI HDR/ATC: non necessarie con `colr` 9/18/9 (spec HLG Apple).

---

## Raccomandazione pipeline container
1. Output `MovOutputFormat({ fastStart: false, metadataFormat: 'mdta' })` + `StreamTarget` su OPFS (`chunked: true`), per RAM bassa e struttura uguale agli originali (moov in coda). Niente `in-memory` e niente fragmented.
2. Video: decode -> encode HEVC Main10 con `VideoSampleSource` (colorSpace esplicito bt2020/hlg/bt2020-ncl, codec string `hvc1.2.4.L*.B0`), **evitare rerender canvas 8-bit**; se bisogna ridimensionare, usare passaggio GPU a 10-bit o confermare con test che il frame resti 10-bit. Rotazione tramite `addVideoTrack(..., { rotation: 270 })` (da `track.rotation` sorgente), non applicarla ai pixel.
3. Audio: passthrough della traccia AAC-LC (`EncodedPacketSink` -> `EncodedAudioPacketSource('aac')`); **scartare `apac`** e `mebx` (documentare all'utente la perdita dell'audio spaziale). Se in seguito si vuole apac, farlo come funzione opzionale con post-processing del moov (sez. 3). → **Fatto in v0.32** (apac) e **v0.33** (tutte le mebx): vedi «Passthrough audio spaziale» e «Passthrough tracce iPhone (v0.33)» in fondo.
4. Metadati: leggere `getMetadataTags().raw` dal sorgente; riscrivere `creationdate` (con fuso), `location.ISO6709`, `make/model/software`. Se Foto non li legge dall'output Mediabunny (`udta/meta`), eseguire un **post-processing finale** del moov: sposta/crea `moov/meta` (mdta) + `udta/©xyz`, appende `amve/mdcv/clli` al `hvc1` copiati dal sorgente, verifica/patcha `colr` 9/18/9. Tutto locale e economico perche' moov e' in coda.
5. Niente dvcC/dvvC: file dichiarato HLG puro.
6. mp4box.js solo come strumento di ispezione/test (non nel percorso di scrittura).

## Test da eseguire
1. File di riferimento: dump box del sorgente (`MP4Box -info`, `mp4dump`, `exiftool -a -G1 -s`) per vedere `moov/meta` vs `udta`, `amve`, `colr` (nclc), dvvC, ordine tracce, `alternate_group`.
2. Mediabunny su iOS Safari reale: `getColorSpace()`, `hasHighDynamicRange()`, `track.rotation`, `getMetadataTags().raw`, `input.getTracks()` (conferma che `mebx` non c'e' e `apac` compare con `codec null`).
3. `VideoEncoder.isConfigSupported({ codec:'hvc1.2.4.L153.B0', colorSpace:{primaries:'bt2020',transfer:'hlg',matrix:'bt2020-ncl'}, ...})` e controllo se `meta.decoderConfig.colorSpace` torna valorizzato; verifica profondita' 10 bit dell'output (`ffprobe pix_fmt yuv420p10le`).
4. Output Mediabunny MOV: dump con ffprobe/MP4Box: `colr` nclc 9/18/9, `hvc1` (non hev1), rotazione tkhd matrix, VFR (stts non uniformi).
5. Salvataggio in Foto (share sheet "Salva video" e import via AirDrop/File): data mostrata, mappa/posizione, badge HDR, riproduzione HDR vs originale (luminosita' simile?); ripetere con e senza `amve`, con e senza `moov/meta` patchato, con data senza fuso vs con fuso (`+0100`).
6. Confronto DV: file con `dvvC` lasciato (ricodificato) vs rimosso -> comportamento Foto/QuickTime/Safari `<video>`.
7. Audio: output senza apac -> AAC stereo in Foto, AirPods/Altoparlante; verificare sincronia (edit list/`elst` iniziale AAC priming).
8. Memoria: file da 1-2 GB su iPhone con `fastStart:false` + OPFS (picco RAM, jetsam); `createWritable()` disponibile?
9. Post-processing moov: round-trip su un file di prova, validare con ffprobe/MP4Box e aprire in QuickTime Player/Foto.
10. (Opzionale) prova di passthrough `apac` via parser/muxer custom su file breve per misurare costo/rischio.

## Diagnosi audio "doppio" nei file del comando rapido (2026-11-18) ✅ misurato
- IMG_7440 (output del comando rapido iOS "Codifica contenuto multimediale" 1080p): unica traccia AAC-LC stereo **44.1 kHz** (l'originale iPhone è 48 kHz → ricampionato).
- Autocorrelazione per finestre da 1 s (8 finestre, L, R e L−R): picco **costante a 41.7–41.8 ms, r ≈ 0.3–0.4** in tutte le finestre → **eco digitale**: il segnale contiene una copia di sé stesso ritardata di ~41.75 ms (≈1841 campioni @44.1 kHz). Un contenuto naturale non darebbe un picco identico in ogni finestra.
- Interpretazione: in fase di export il comando rapido ha sommato due sorgenti audio (verosimilmente il render della traccia spaziale `apac` + la traccia AAC stereo) sfasate di ~42 ms. Il danno è "cotto" nell'AAC: non è un problema di tracce/metadati.
- Possibile riparazione: filtro a pettine inverso IIR y[n] − a·x[n−d] (stima di a e d per file dall'autocorrelazione), richiede decodifica+ricodifica AAC (WebCodecs AudioDecoder/AudioEncoder). Da valutare a orecchio.
- **Esito riparazione eco (v0.7.2 su device)**: stima corretta sul device (d 41.81 ms, gain 0.71/0.06, rho 0.46→0.02) ma all'ascolto "eco mostruoso". Riproduzione in Chromium del percorso decode+filtro: PCM corretto pulito (autocorr d..5d ≤ 0.08) ⇒ cause possibili: ricodifica AAC Safari (non riproducibile qui: Chromium non codifica AAC) o percezione (eco tolta solo <2 kHz, alte ancora doppie → effetto flanger). Le due sorgenti sommate non sono identiche → un filtro lineare fisso non può pulire. **Decisione: riparazione eco disattivata (sperimentale)**; strada consigliata = comprimere l'originale 4K (audio pulito) con scalatura a 1080p.
- **Filtro eco v2** (FIR 129 tap per canale, LS su segnale sbiancato LPC, inverso IIR, cap max|H| ≤ 0.9). rho a d per banda (<500 / 0.5–2k / 2–6k / >6k), cepstrum comb: v0 .47/.38/.23/.06 comb 48.7; v1 .09/.12/.18/**.16** comb 39.6 (v1 PEGGIORA le alte → flanger); **v2 .08/.08/.18/.05 comb 21.9**. Limite 2–6 kHz: le sorgenti non sono legate da un filtro LTI → eco residua possibile. In app come "ripara eco v2".
- **Ascolto su iPhone (utente)**: "solo ricodifica" ≈ uguale all'originale → **ricodifica AAC Safari innocente**; v1 "aumenta eco e forse riverbero" → coerente con rho >6 kHz 0.06→0.16 misurata. In attesa: v2.
- **2026-11-18 — Decisione utente**: "audio pulito da file originale" è **fuori perimetro** → rimosso (revert v0.10). Si prosegue solo con la riparazione dell'eco sul file stesso (v2 in app, v3 in sviluppo).
- **Filtro eco v3** (STFT 1024/256, RLS per bin, riferimento L↔R >1.5 kHz, post-filtro Wiener β 0.3): rho per banda .11/.08/**.08**/.03, comb 15.2 (v2: .08/.08/.18/.05, 21.9); danno −1.8/−1.3/−2.3/−0.3 dB; negativi ≤0.22 dB. Latenza 768 campioni compensata (verificato Chromium: lag 0, lunghezza identica). In app come "ripara eco v3" (v0.11).
- **Bug v3 (v0.11–0.12) → fix v0.12.1**: su device silenzio totale. Causa: il decoder AAC del browser emette prima 2 blocchi di silenzio digitale (priming) → nel v3 `coh = …/(A00[k]·syy)` = 0/0 = NaN, che si propaga per sempre (ffmpeg in lab taglia il priming, quindi i test non lo vedevano). Fix: denominatori regolarizzati, det quasi-singolare = nessun aggiornamento, guardia NaN sui coefficienti. Verificato: 2048 zeri iniziali → 0 NaN; percorso Chromium → 0 NaN, rms 0.020, lag 0. Lezione: testare sempre con priming/silenzio iniziale.

## Verità di riferimento: coppia IMG_2790 (4K originale pulito + 1080p comando rapido) — 2026-11-18 ✅
File ricevuti in chat (NON nel repo, privacy). Analisi in /tmp/claude-0/lab/e2790.
- Allineamento: ritardo 0. RMS rovinato ≫ pulito (+4 dB): somma di due copie.
- **Risposta all'impulso 2×2 identificata (Wiener MIMO)**: percorso diretto ≈ 0.64·x (lievemente passa-basso, ±0.02 ms) + **copia ritardata a 41.2–41.8 ms che è un MIX STEREO DIVERSO** (termini incrociati L↔R con segni alternati) → firma di un render ambisonico (apac) → stereo sommato in ritardo. Il modello LTI spiega 87–88 % (residuo −9 dB): il resto non è descrivibile da un filtro fisso.
- **Livello eco (copia ritardata / diretto) misurato contro il pulito**: rovinato **+1.7 / +0.5 dB** (la copia è forte quanto il diretto!); v1 −3.5/−7.6; v2 −3.2/−8.4; v3 −4.5/−8.6; **limite teorico (Wiener non causale con H vera) −11.9/−10.6 dB**.
- **Inverso ricorsivo (causale) con H vera = INSTABILE** (|copia| ≥ |diretto|): spiega perché v1/v3 suonano peggio. Serve inversione **non causale sull'intero file** (siamo offline: possibile).
- Ipotesi da verificare: H è (quasi) uguale per tutti i file del comando rapido (stessa regola di render) → "profilo comando rapido" misurato una volta e applicato con deconvoluzione di Wiener non causale. Validazione: serve una seconda coppia.
- **Seconda coppia IMG_2813 (3.4 s)** → **il "profilo comando rapido" NON è universale**: risposta diretta simile (≈0.66·x, sfasamento di mezzo campione), ma la **copia ritardata è scorrelata tra i due video (corr −0.003)** → dipende dal contenuto spaziale (render apac del campo sonoro), non da una regola fissa. Profilo 2790 applicato a 2813: −3.6/−5.0 dB contro oracolo proprio −9.1/−10.1.
- Livelli eco su 2813: rovinato −1.0/−1.1; v1 −4.8/−7.1; **v2 −6.4/−7.6**; v3 −4.9/−7.0; oracolo −9.1/−10.1. ⚠️ `detectEcho` dà found=false su 2813 (falso negativo: in app la correzione non partirebbe) → soglie da rivedere.
- Conclusione: il massimo teorico con un filtro lineare per-file è ≈ −9/−12 dB di eco residua; i filtri ciechi attuali arrivano a −4/−9. Margine residuo ~3–5 dB, recuperabile solo con stima cieca non causale sull'intero file (v4). Banco di prova oggettivo ora disponibile: tools/lab/echo_lab.py + 2 coppie con riferimento pulito (file solo in /tmp, non nel repo).
- **Filtro eco v4 (v0.14)**: stima cieca non causale sull'intero file (C = A⁻¹B 2×2, ±1.7 ms attorno a d, punto fisso Wiener MIMO + LS), deconvoluzione overlap-save. echo_level vs pulito: 2790 **−5.4/−10.8** (oracolo −11.9/−10.6), 2813 **−10.2/−13.4** (oracolo −9.1/−10.1). Danno per banda contenuto (2790 >6k −3.9 dB). 60 s stereo 48 k: ~4 s, ~115 MB extra. Da applicare solo con detectEcho found=true (forzato su audio pulito danneggia). detectEcho rifatto (finestre 0.25 s, mediana profili, M=L+R e S=L−R): veri positivi 2790/2813/7440, negativi x puliti/2147/sintetico; margine stretto (tarato su 6 segnali). Verificato: priming → 0 NaN; percorso Chromium: 0 NaN, lag 0, lunghezza identica.

## Passthrough audio spaziale (v0.32) ✅ misurato su IMG_2147 e IMG_2790

Modulo `app/lib/apac.js`, test `app/lib/apac.test.mjs` (in `tools/run-tests.sh`). Mediabunny continua a ignorare `apac` (sez. 1.2): la traccia viene **trapiantata a fine job**, senza decodificarla.

**Struttura sorgente (iPhone, misurata)**: `apac` è un sample entry QuickTime SoundDescription **v2** (sample rate float64 = 48000, 4 canali, 1024 frame/pacchetto, box figlio `dapa`), `stbl` con `stts`, `stss`, `stsc`, `stsz`, `stco` + `sgpd`/`sbgp` di tipo `prol`; `dref` = `alis` self. La traccia `apac` ha **`tref/fall` → track_ID dell'AAC** (fallback stereo) e lo stesso `alternate_group` 1 dell'AAC; edit list propria (es. media_time 1168 su 48 kHz in IMG_2147, 0 in IMG_2790; l'AAC ha il suo priming, 1232/2112). Le flag **non sono fisse**: IMG_2147 = apac `0xf` (abilitata) + AAC `0xe` (disabilitata, riserva); IMG_2790 = apac `0xe` + AAC `0xf` (file su cui l'audio spaziale risulta spento). Per questo si copiano le flag del sorgente, non si impongono. Peso: ~0,39 Mbps (0,16 MB per 3,5 s).

**Pipeline** (solo se la sorgente ha `apac`, l'opzione «Audio spaziale (apac) — mantieni» è attiva — default ON, visibile solo con apac — e l'audio in uscita è la **copia** dell'AAC originale; con riparazione eco/ricodifica la traccia NON viene aggiunta e il log dice perché: conterrebbe ancora l'audio originale, diverso dall'AAC corretto, e Foto sceglierebbe quella):
1. `readApacTrack(srcMoov)`: trak `soun` con entry `apac`; tkhd (flag, alternate_group, volume, durata), mdhd (timescale, durata, lingua), hdlr, elst, `stsd` **verbatim**, tabelle `stbl` verbatim (tranne stco/co64), offset/dimensione di ogni campione e di ogni chunk nel file sorgente; flag/gruppo dell'AAC sorgente (quello puntato da `tref/fall`).
2. Mediabunny scrive il file come prima (moov in coda); `rewriteMoov` dà `prefixLength` e il moov con i metadati copiati.
3. OPFS: tronca a `prefixLength`, scrive un **secondo `mdat`** (header a 8 byte, o `largesize` a 16 byte se > 4 GiB) e ci copia i chunk `apac` **nello stesso ordine e con la stessa struttura** letti dal `File` sorgente (`file.slice`, 6 letture in parallelo, chunk adiacenti uniti, scritture a blocchi da 1 MB via worker: nessun accumulo in RAM).
4. `addApacTrack(moov, …)`: nuovo `trak` dopo l'ultimo (track_ID = `mvhd.next_track_ID`, poi `next_track_ID`+1; `mvhd.duration` allungata se serve), tkhd sorgente con track_ID/durata nuovi (flag e `alternate_group` invariati), `edts` riscalato, `tref/fall` → track_ID dell'AAC in uscita, `mdia` = mdhd + hdlr sorgente + `minf`(smhd, `dinf/dref` `url ` self, `stbl` verbatim + **stco nuovo**, o **co64** se un offset supera 4 GiB). L'AAC in uscita riceve le flag tkhd dell'AAC sorgente e lo stesso `alternate_group` dell'apac → i player ne riproducono una sola, come nell'originale. `stsc` resta valido perché i chunk sono copiati 1:1.
5. Il moov aggiornato va in coda dopo il secondo mdat: `[ftyp][mdat Mediabunny][mdat apac][moov]`.

**Allineamento temporale**: la pipeline video ribasa i tempi sottraendo `frames[0].ts` (di solito 0) e scarta i pacchetti con ts < 0 (anche l'AAC, priming incluso). Per `apac` **nessun campione viene tagliato**: la stessa traslazione si applica alla edit list (`shiftEdits`: `segment_duration` −= shift, `media_time` += shift × timescale media; le edit vuote si accorciano), poi `segment_duration` è riscalata dal timescale del movie sorgente (600) a quello dell'uscita. Con shift 0 la `media_time` è identica alla sorgente, quindi apac parte esattamente come nell'originale.

**Verifiche (Node, ffmpeg come «Mediabunny»: x265 + AAC copiato, moov in coda; anche variante co64 forzata)**: ffprobe elenca `apac` 4 ch 48 kHz con lo **stesso numero di pacchetti** (167 / 120) e **SHA-256 per pacchetto identici** alla sorgente; flag/alternate_group di apac e AAC come nel sorgente; `tref fall` → AAC; track_ID univoci; file decodificabile (`-map 0:v -map 0:a:0`), durata entro 0,1 s. In Chromium (Playwright) lo stesso percorso con **Mediabunny vero + worker OPFS**: hash dei pacchetti identici, decodifica ok, nessun errore in console.

❓ Da verificare su iPhone: Foto riproduce l'audio spaziale (cuffie AirPods con audio spaziale / altoparlanti), «Mix audio» (Standard / In quadro / Studio / Cinematografico) disponibile nella modifica del video; Safari/QuickTime riproducono; i player senza decoder apac (Chrome, VLC, Windows) restano muti se l'AAC è disabilitato come nell'originale (stesso comportamento del file iPhone).


## Passthrough tracce iPhone: apac + tutte le mebx (v0.33) ✅ misurato su IMG_2147 e IMG_2790

**Problema (iPhone, v0.32)**: sul file compresso con apac copiato Foto **non offre «Mix audio»**. Tracce degli originali (tkhd/tref/keys, misurate):
- IMG_2790 (4K): 1 `hvc1`; 2 `mp4a` abilitata alt 1; 3 `apac` disabilitata alt 1, `fall`→2; 4 mebx `video-orientation` `cdep`→1 `cdsc`→1; **5 mebx `cinematic-audio` `cdsc`→3 (apac)**; 6 mebx `detected-face` (bounds, face-id, roll/yaw) `cdep`/`cdsc`→1; 7 mebx `live-photo-info` + `optical-center` `cdep`/`cdsc`→1; 8 mebx `scene-illuminance` `rndr`→1; 9 mebx `segment-identifier` (nessun tref).
- IMG_2147: 2 `apac` alt 1 `fall`→3, 3 `mp4a`, 4 mebx `scene-illuminance` `rndr`→1.
- Struttura mebx: handler `meta` («Core Media Metadata»), `minf` con `gmhd` + `hdlr dhlr alis` + `dinf/dref alis` (self), `stsd/mebx/keys/<id locale>/keyd` (`mdta` + nome chiave), `stts/stsz/stsc/stco`, edit list propria; `mdia` può contenere `elng`.
→ «Mix audio» richiede quasi certamente la mebx `cinematic-audio` che punta alla traccia apac.

**Modulo `app/lib/passthrough.js`** (usa le primitive di `apac.js`; test `app/lib/passthrough.test.mjs` in `tools/run-tests.sh`):
1. `readPassthrough(srcMoov)`: traccia `apac` (qualunque trak con sample entry `apac`, indipendente dall'ordine apac/AAC), **tutte le trak con entry `mebx`** (con chiavi lette da `keyd`), id del video e dell'AAC sorgente (quello del `fall`), tref per traccia. Una trak illeggibile finisce in `errors` (log `warn`) senza bloccare le altre.
2. `selectPassthrough(info, {apac, meta, aacOut})`: apac solo se l'AAC in uscita è la copia dell'originale (come v0.32). Una traccia si copia solo se **ogni destinazione tref esiste in uscita** (video, AAC, o un'altra traccia copiata; punto fisso): senza apac la `cinematic-audio` viene **saltata** (riferirebbe una traccia inesistente) e loggata; le mebx del video si copiano sempre (anche con eco riparata/ricodifica o sorgente senza apac, es. 1080p del comando rapido).
3. `planPassthroughMdat(tracks, pos)`: **un solo secondo mdat** con i chunk di tutte le tracce in **ordine di file sorgente** (letture sequenziali, chunk adiacenti uniti), `largesize` se > 4 GiB; `copyPassthroughData` = streaming a blocchi da `file.slice` al worker OPFS (nessun accumulo in RAM).
4. `addPassthroughTracks(moov, info, tracks, …)`: track_ID nuovi da `mvhd.next_track_ID` in ordine di sorgente; **tref rimappati** con la mappa ID (video sorgente → video in uscita, AAC sorgente → AAC in uscita, traccia copiata → nuovo ID; tipi `cdsc`, `cdep`, `rndr`, `fall`, … qualsiasi); trak = tkhd sorgente (flag e `alternate_group` invariati, ID/durata nuovi) + `edts` traslato/riscalato (come apac) + `tref` rimappato + `mdia` verbatim (mdhd, hdlr, elng) con `minf` verbatim (smhd/gmhd/nmhd + dhlr; `dinf` verbatim se self-reference, altrimenti `url ` self; se manca l'header media: `nmhd` per meta, `smhd` per audio) e `stbl` verbatim + **stco/co64 nuovi**; altri figli della trak (`udta`, `meta`, …) **verbatim**. `mvhd.next_track_ID` = max+1. Se c'è apac, l'AAC in uscita riceve flag e gruppo come prima (v0.32).
5. Layout: `[ftyp][mdat Mediabunny][mdat tracce iPhone][moov + trak copiati]`. Se la copia fallisce (errore non di annullamento) il file resta valido senza tracce extra e il log riporta `⚠️ tracce iPhone NON copiate: …` (`warn`).

**Opzione UI**: «Mantieni audio spaziale e metadati iPhone» (default ON, chiave impostazioni `apac` invariata per compatibilità), visibile se la sorgente ha apac **o** mebx; chip «Metadati iPhone».

**Log** (categorie esplicite, quindi nel riassunto di «Copia log»): `setup` = cosa c'è nella sorgente, cosa si copia e perché no (apac escluso, cinematic-audio senza apac, opzione spenta, sorgente senza tracce); `summary` = `tracce iPhone copiate: N (… MB) · apac 3→3 fall→2 · cinematic-audio 5→5 cdsc→3 · … · mappa ID 1→1 2→2 …` + riga audio spaziale/AAC; `warn` = errori. **Diagnosi del log iPhone v0.32** (1080p con apac, «audio spaziale: copiati …» assente dal riassunto): le righe apac v0.32 non avevano categoria e, essendo emesse dopo i segmenti, `classify` le metteva in `info` → escluse dal riassunto; il peso (8,67 MiB = video ~8,05 + AAC ~0,2 + apac ~0,39 + moov) è compatibile con apac **presente**. Nessun difetto trovato nel rilevamento (ordine apac/AAC indifferente); da v0.33 l'esito è sempre visibile.

**Verifiche**: Node (ffmpeg come «Mediabunny», moov in coda; varianti normale, co64 forzato, senza apac): ffprobe vede apac + tutte le mebx (IMG_2790: 1+6, IMG_2147: 1+1); per ogni traccia copiata **stesso numero di pacchetti e SHA-256 per pacchetto identici**; tref rimappati (parse dei box: `cinematic-audio cdsc` → nuovo ID apac, `cdep/cdsc/rndr` → video, `fall` → AAC); flag/`alternate_group` come sorgente; `next_track_ID`; decodificabile; durata entro 0,1 s; senza apac la cinematic-audio è saltata e le altre 5 copiate. Chromium (Playwright, app completa con encoder H.264 al posto di HEVC su sorgenti H.264 che portano apac+mebx trapiantate): log e riassunto corretti, hash per pacchetto identici su tutte le tracce copiate, nessun errore in console.

❓ Da verificare su iPhone: «Mix audio» disponibile in Foto sul file compresso; Live Photo/volti non alterano la riproduzione.
