# Mediabunny API (verificato su 1.65.1)

Fonte: `npm pack mediabunny@1.65.1`, `.d.ts` in `package/dist/modules/src/*.d.ts` (cit. come file:riga) e sorgenti `package/src/**`.

## 1. Versione e CDN
- Ultima: 1.66.0 (2026-11-13, solo 5 gg). Ultima con >=14 gg: **1.65.1** (2026-11-03, 15 gg). 1.65.2 (2026-11-04 19:26 UTC) ha <14 gg: scartata.
- Script classico (IIFE, globale `Mediabunny`): `https://cdn.jsdelivr.net/npm/mediabunny@1.65.1/dist/bundles/mediabunny.min.cjs`
  (il file inizia con `"use strict";var Mediabunny=(()=>{...})()` + `if (typeof module...) Object.assign(...)`; in un `<script>` classico `var` top-level => `window.Mediabunny`). ~724 KB.
- Solo ESM: `https://cdn.jsdelivr.net/npm/mediabunny@1.65.1/dist/bundles/mediabunny.min.mjs` (`import * as MB from '...'`). Esistono anche `mediabunny.cjs/.mjs` non minificati.
- Un solo bundle: non caricare due copie (il bundle stampa warning se `globalThis` ha gia' il marker, vedi fine file).
- `const {Input, BlobSource, ALL_FORMATS, EncodedPacketSink, Output, MovOutputFormat, Mp4OutputFormat, BufferTarget, StreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket} = Mediabunny;`

## 2a. Input da File
```js
const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS }); // input.d.ts:~20, source.d.ts:177
const v = await input.getPrimaryVideoTrack();          // InputVideoTrack|null (input.d.ts getPrimaryVideoTrack)
const audios = await input.getAudioTracks();           // InputAudioTrack[]; getPrimaryAudioTrack() esiste
const codec = await v.getCodec();                      // 'hevc'|'avc'|... (VideoCodec)
const cfg = await v.getDecoderConfig();               // VideoDecoderConfig|null: codec 'hvc1.…', description (hvcC), colorSpace, codedWidth/Height
const rot = await v.getRotation();                     // 0|90|180|270 CW; v.getFlip() boolean; getTransformationMatrix()
const w = await v.getCodedWidth(), h = await v.getCodedHeight();      // PRIMA della rotazione
const dw = await v.getDisplayWidth(), dh = await v.getDisplayHeight(); // DOPO rotazione (input-track.d.ts:430-442)
const cs = await v.getColorSpace();                    // VideoColorSpaceInit {primaries,transfer,matrix,fullRange}
const hdr = await v.hasHighDynamicRange();
const dur = await input.computeDuration();             // secondi (preciso); getDurationFromMetadata() economico, puo' essere null
const t0 = await v.getFirstTimestamp();                // secondi
const stats = await v.computePacketStats();            // packetCount, averagePacketRate, averageBitrate (input-track.d.ts:23-27, 287)
const fr = await v.computeFrameRateMetrics();          // frameRateIsConstant, averageFrameRate... (:463)
const a = audios[0]; await a.getCodec() /* 'aac' */; await a.getNumberOfChannels(); await a.getSampleRate(); await a.getDecoderConfig(); // AudioDecoderConfig con description=AudioSpecificConfig
const tags = await input.getMetadataTags();            // input.d.ts getMetadataTags -> MetadataTags
```
- Le property sincrone (`v.codec`, `v.rotation`, `codedWidth`...) sono `@deprecated`: usare i `getX()` async.
- Tag normalizzati: `title, description, artist, album, comment, genre, date (Date), creationTime, images, ...` (metadata.d.ts:25-60).
- **QuickTime mdta**: `tags.raw` (metadata.d.ts:~75) e' un `Record`; per MOV/MP4 con `keys` atom le chiavi sono i nomi del `keys` (demuxer isobmff-demuxer.ts:2898-2944), quindi:
  `tags.raw['com.apple.quicktime.creationdate']` (stringa, es. `2024-05-01T10:00:00+0200`; mappa anche su `tags.date` = `new Date(str)`, riga ~2990) e `tags.raw['com.apple.quicktime.location.ISO6709']` (stringa `+45.1234+009.1234+120.000/`). Atom `udta` top-level (`©xyz`, `loci`...) finiscono in `raw` come stringa (©xxx) o `Uint8Array`.

## 2b. Pacchetti video senza decodifica
```js
const sink = new EncodedPacketSink(v);                 // media-sink.d.ts:48
for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
  p.timestamp /*s, PTS*/; p.duration /*s*/; p.type /*'key'|'delta'*/; p.sequenceNumber; p.byteLength; p.isMetadataOnly /*data = PLACEHOLDER*/;
}
```
- `PacketRetrievalOptions.metadataOnly` (media-sink.d.ts:17-22): `data` non e' letto; incompatibile con `verifyKeyPackets` (che legge il bitstream per correggere il tipo key).
- Ordine di iterazione = ordine di decodifica; `timestamp` e' il PTS (puo' non essere monotono con B-frame). `getFirstPacket/getPacket(t)/getNextPacket/getKeyPacket/getNextKeyPacket` disponibili (:55-90).

## 2c. Pacchetti audio AAC (passthrough)
```js
const asink = new EncodedPacketSink(aTrack);
const aacCfg = await aTrack.getDecoderConfig();        // description = AudioSpecificConfig (da MP4/MOV); se assente il muxer vuole ADTS + priming packet (isobmff-muxer.ts:561)
for await (const p of asink.packets()) { /* p.data raw AAC, p.timestamp/duration in secondi */ }
```

## 2d. Output
```js
const output = new Output({
  format: new MovOutputFormat({ fastStart: 'in-memory', metadataFormat: 'mdta' }), // o new Mp4OutputFormat({...}); output-format.d.ts:88-132, 184, 221
  target: new BufferTarget()                           // .buffer: ArrayBuffer|null dopo finalize (target.d.ts:68)
  // oppure new StreamTarget(writableStream, {chunked?, chunkSize?}) -> chunk {type:'write', data, position} (target.d.ts:79-113)
});
const vsrc = new EncodedVideoPacketSource('hevc');     // media-source.d.ts:39
const asrc = new EncodedAudioPacketSource('aac');      // :179
output.addVideoTrack(vsrc, { rotation: rot /*0|90|180|270*/, flip?, frameRate?, maximumPacketCount?, decoderConfig?, primingPacket? }); // output.d.ts:163-203
output.addAudioTrack(asrc, { languageCode?, decoderConfig? });
output.setMetadataTags({ creationTime: new Date(...), raw: {...} });  // PRIMA di start(); ultima chiamata vince (output.d.ts:311)
await output.start();
await vsrc.add(pkt, { decoderConfig: cfgV });          // meta SOLO sul primo; decoderConfig obbligatorio (codec, codedWidth/Height interi; description = hvcC) (codec.ts:1137-1182)
await asrc.add(apkt, { decoderConfig: aacCfg });
vsrc.close(); asrc.close();   // poi:
await output.finalize();
```
- `add()` ritorna Promise: `await` per backpressure. Decoder config con `description` HEVC: il muxer scrive i byte cosi' come sono dentro `hvcC` (isobmff-boxes.ts:838). Senza `description` assume Annex B + serve primo pacchetto (isobmff-muxer.ts:466-486).
- Pacchetti: `new EncodedPacket(data, type, timestamp_s, duration_s, sequenceNumber?)` oppure `EncodedPacket.fromEncodedChunk(chunk)` (packet.d.ts). Per passthrough si puo' passare direttamente il `p` letto dal sink; `p.clone({timestamp, duration})` per shiftare.
- Il muxer ricostruisce da solo ctts/B-frame e `elst` da timestamp (isobmff-boxes.ts:519-560): passare PTS originali (anche con start != 0) preserva il sync A/V.
- `fastStart`: `false` | `'in-memory'` (moov in testa, tutto in RAM) | `'reserve'` (serve `maximumPacketCount` per ogni traccia) | `'fragmented'`; default = auto in base al target (output-format.d.ts:116).
- **Metadata**:
  - MOV `auto` => `moov/udta/<©nam,©day,...>` (QuickTime classico); MP4 `auto` => `moov/udta/meta` hdlr `mdir` (ilst `©nam`...). `metadataFormat:'mdta'` => `moov/udta/meta` con hdlr `mdta` + `keys` + `ilst` (isobmff-boxes.ts:1675-1696, 1973-1995). NB: mai `moov/meta` diretto.
  - **`raw` con chiave custom (es. `com.apple.quicktime.creationdate`) viene SCARTATA silenziosamente** se `metadataFormat` e' `auto/mdir/udta` (richiede `key.length === 4`, righe ~1763 e ~1930). Va usato `'mdta'` (chiavi di lunghezza libera, valori `string` => data type 1 UTF-8).
  - In `mdta` i tag normalizzati sono scritti con chiavi corte (`title`, `artist`, `date`=solo `YYYY-MM-DD`, ...), non `com.apple.quicktime.*`: per la data completa con fuso scrivere `raw['com.apple.quicktime.creationdate'] = '2024-05-01T10:00:00+0200'` esplicitamente. `creationTime` va in mvhd/tkhd (default `now` se `undefined`; `null` = non scrivere).
  - In `udta` (MOV auto) `images`, `trackNumber` ecc. non sono scritti.

## 2e. Box colr
- Scritto in `stsd/hvc1` solo se `decoderConfig.colorSpace` non e' vuoto (almeno un campo != null) (isobmff-boxes.ts:775-778; misc.ts:463).
- **MOV**: `colr` tipo `nclc` (primaries, transfer, matrix u16; NESSUN flag full-range). **MP4**: `nclx` + byte `fullRange<<7` (`fullRange` false/undefined => 0 => limited) (:808-830).
- Campi mancanti => 2 (unspecified). Mappe valori: `bt709`->1, `smpte170m`... (COLOR_PRIMARIES_MAP ecc.). Quindi il MOV non puo' esprimere `fullRange:true` (limitazione del formato nclc; si perde l'informazione).
- Per passthrough: passare `colorSpace: await v.getColorSpace()` dentro `decoderConfig` (gia' presente in `getDecoderConfig()`).
- Il codec box e' sempre `hvc1` per `hevc` (`videoCodecToBoxName`, isobmff-boxes.ts ~2010), anche se il codec string e' `hev1` => allinea con Safari.

## 2f. Timestamp
- Tutta l'API pubblica e' in **secondi** (float). I microsecondi esistono solo come getter `microsecondTimestamp/microsecondDuration` e nei chunk WebCodecs (`fromEncodedChunk` converte).
- Timescale video: se `frameRate` non e' impostato => 57600 (`GLOBAL_TIMESCALE`, isobmff-muxer.ts:58) altrimenti denominatore di 1/frameRate. `frameRate` **fa lo snapping** di timestamp/durata a quella griglia (output.d.ts:178-182): per VFR NON impostarlo. Senza `frameRate` il VFR e' supportato (stts per-sample).
- Validazione (muxer.ts:42-66): primo pacchetto deve essere `key`; timestamp non < max timestamp del GOP precedente, altrimenti throw.

## 3. Trappole / issue (titoli letti via ricerca GitHub; corpi non accessibili)
1. `raw` custom key scartata se `metadataFormat` non e' `'mdta'` (verificato nel codice, vedi 2d). Inoltre il risultato e' in `moov/udta/meta`, non `moov/meta`: Apple Foto/Safari potrebbero non leggere la data/localita' => testare su dispositivo.
2. MOV `colr` = nclc senza fullRange; MP4 = nclx. Chiedere `colorSpace` solo se noto; vuoto => nessun `colr` (Safari puo' assumere BT.709 o BT.601). Issue #623 (aperta): "Color shift H.264 con BT.601 solo-container su macOS Chrome"; #474/#398 (chiuse): parsing colorSpace/nclc; #555 (chiusa): WebKit restituisce valori colorSpace non standard ('unspecified') che facevano throw in `VideoSample`.
3. `frameRate` snappa i timestamp (rompe VFR); `'reserve'` richiede `maximumPacketCount`; `fastStart:'in-memory'` tiene tutto in RAM (file grandi su iOS).
4. Safari/WebKit: #173 "Conversion on iOS/macOS Safari" (chiusa), #587 "iOS 26.2 WebKit: H.264 VideoEncoder non emette output" (chiusa 2026-10-28, riferisce #541 ancora viva su iOS), #137/#138 `canDecode()` falso solo in Safari. Con passthrough (nessun encode/decode) si evitano, ma `isConfigSupported` non va usato per decidere sul passthrough.
5. #454 (chiusa): `tkhd.alternate_group` rendeva i controlli Safari non auto-nascondenti; #450 depth sample description MOV (ProRes). Usare >=1.65.1 che include le fix.
6. `getDecoderConfig()` puo' essere `null` (codec sconosciuto): gestire; `description` e' un `Uint8Array`/BufferSource da passare tale e quale.
7. Dopo `finalize()`, `BufferTarget.buffer` e' `ArrayBuffer`: `new Blob([target.buffer], {type: await output.getMimeType()})`.
