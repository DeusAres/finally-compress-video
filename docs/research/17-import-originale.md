# 17 · Importare l'originale del video (Libreria foto, File, trascinamento)

Problema: trascinando un video dall'app Foto nella webapp (o scegliendolo da «Libreria foto») arriva un file più leggero
dell'originale. Domanda: la pagina può forzare l'originale?

Legenda: ✅ verificato (sorgente WebKit o file misurati) · 🟡 fonte esterna attendibile ma non provata qui · ❓ ipotesi da
provare con `tools/diag/import.html`.

## 1. In breve

- ✅ **Dalla «Libreria foto» del selettore file Safari non consegna mai l'originale byte per byte.** WebKit apre
  `PHPickerViewController` in modalità **`.compatible`** (la preferenza che sceglierebbe `.current` è interna e spenta di
  default); se fosse `.current`, WebKit riesporterebbe comunque il video con `AVAssetExportPresetHighestQuality`.
  Nessun valore di `accept`, `multiple` o `capture` cambia questa scelta per i video (§2).
- ✅ **Da «Scegli file» (app File) il file arriva intatto**: `UIDocumentPickerViewController` in modalità import, il file
  viene solo copiato/spostato in una cartella temporanea (§2.3).
- ✅ **Nel trascinamento la pagina non ha alcun controllo**: WebKit chiede all'`NSItemProvider` di Foto il tipo più
  fedele che conosce e prende il file che Foto produce; cosa produca Foto (originale o copia ricodificata) lo decide Foto
  (§3). Il `dataTransfer` espone solo `Files`.
- ✅ **La copia ricodificata è riconoscibile** (misurato su due file dell'utente dello stesso video, §4): chiave
  `com.apple.quicktime.displayname`, traccia AAC spostata prima del video, apac (audio spaziale) tolto, 4K → 1080p,
  ora di scrittura = ora dell'esportazione. Resta HEVC 10 bit HLG con Dolby Vision 8.4 e tracce mebx: quindi «HEVC
  senza 10 bit/DV» **non** è il criterio giusto.
- Cosa fa l'utente: **Foto › Condividi › Opzioni › Formato «Attuale» › Salva in File**, poi nella webapp «Scegli file».
  🟡 Apple: «Attuale» evita la conversione di formato. ❓ Da verificare se «Salva in File» con «Attuale» dà proprio il
  file della fotocamera (4K, apac) e se la voce «Opzioni › Attuale» del selettore foto di Safari ha effetto sui video.

## 2. Selettore file (`<input type=file>`) — sorgente WebKit

File: `Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm` (WebKit `main`, novembre 2026;
https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm).

### 2.1 Da `accept` ai tipi

- ✅ `presentWithParameters:`: ai MIME di `accept` si aggiungono le estensioni convertite in MIME
  (`.mov` → `video/quicktime`); `UTIsForMIMETypes`: `*/*` → **insieme vuoto** (= nessun filtro), `video/*` e
  `audio/*` → `public.movie`, `image/*` → `public.image`, gli altri → `UTType typeWithMIMEType`
  (`video/quicktime` → `com.apple.quicktime-movie`, che è conforme a `public.movie`).
- ✅ Insieme vuoto (accept assente o `*/*`) → menu con Libreria foto (foto+video), fotocamera, «Scegli file».
  Con un tipo conforme a `public.movie` → stesso menu, filtro solo video. Con **nessun tipo immagine/video** (es.
  `accept="application/octet-stream"`) il menu **non appare** e si apre direttamente File (`showDocumentPickerMenu`:
  «If directories are allowed or no image/video types are accepted, skip showing the context menu»).
- ✅ `multiple` imposta solo `selectionLimit` del picker (0 = illimitato) e `allowsMultipleSelection` di File: **non**
  cambia la modalità di rappresentazione. (Il vecchio trucco «`multiple` evita la compressione» valeva con
  `UIImagePickerController`; 🟡 il forum Apple 731042 conferma che non funziona più.)
- ✅ `capture` porta direttamente alla fotocamera (registrazione nuova, `UIImagePickerController`): irrilevante qui.

### 2.2 «Libreria foto» = PHPicker `.compatible`

```objc
- (PHPickerConfigurationAssetRepresentationMode)_preferredAssetRepresentationMode {
    // FIXME (270470): `...ModeCurrent` should always be used and transcoding should be done based on the value of the `accept` attribute
    if (![delegate ...fileUploadPanelPhotoPickerPrefersOriginalImageFormat:self]) return ...ModeCompatible;
    if (![_acceptedUTIs count]) return ...ModeCurrent;
    if ([_acceptedUTIs containsObject:UTTypeImage.identifier]) return ...ModeCurrent;
    return ...ModeCompatible;
}
```

- ✅ Il delegato (`WKContentViewInteraction.mm`) restituisce la preferenza `PhotoPickerPrefersOriginalImageFormat`,
  definita in `UnifiedWebPreferences.yaml` come `status: internal`, `defaultValue: false`. ⇒ in Safari normale la
  modalità è **sempre `.compatible`**, qualunque `accept`. 🟡 Non verificato se Safari la accende per conto suo (la
  pagina non può saperlo; il nome e il FIXME parlano di formato immagine).
- ✅ Anche con `.current`, `picker:didFinishPicking:` chiama `_uploadMediaItemsTranscodingVideo:` (attivo su iOS:
  `ENABLE_TRANSCODE_UIIMAGEPICKERCONTROLLER_VIDEO`), che riesporta ogni video con
  `AVAssetExportSession` preset **`AVAssetExportPresetHighestQuality`** in `.MOV` (classe `WKFileUploadMediaTranscoder`):
  di nuovo non l'originale (❓ se tenga apac/mebx/DV).
- ✅ `[configuration _setAllowsDownscaling:YES]` (SPI) — ❓ probabilmente il motivo per cui la copia «compatibile» di un
  4K arriva a 1080p (§4).
- ✅ Il file scelto viene letto con `loadFileRepresentationForTypeIdentifier:` del primo tipo conforme a `public.movie`
  fra i `registeredTypeIdentifiers` dell'item: cosa contenga lo decide Photos. 🟡 Forum Apple 791191 (iOS 18.5): per un
  HEVC il provider non offre `public.hevc` e il file arriva **transcodificato in H.264**; forum 736545 (2023): anche con
  `.current` un HEVC di 110 MB arriva da 35 MB («Preparing…»); risposta Apple: senza `.current` la transcodifica può
  avvenire, Slo-Mo/Cinematic hanno gli effetti «cotti».
- 🟡 Da iOS 17 il picker foto ha un pulsante **Opzioni** con **Formato: Automatico / Attuale / Più compatibile**
  (forum 743037, picker di Safari). ❓ Non verificato se «Attuale» scelto dall'utente prevalga su `.compatible` richiesto da
  WebKit, né se valga per i video: è la prima prova da fare con la pagina diag.

### 2.3 «Scegli file» = File, nessuna conversione

- ✅ `showFilePickerMenu`: `UIDocumentPickerViewController` con i tipi di `accept` (o `public.item`), modalità
  `UIDocumentPickerModeImport`; in `didPickDocumentsAtURLs:` il file viene solo spostato/copiato in una cartella
  temporanea (`_moveToNewTemporaryDirectory:`). Nessuna `AVAssetExportSession`. 🟡 Forum 731042: «se l'utente copia il
  video in File e lo carica dal prompt "browse" arriva non compresso».
- Limite: File non sfoglia la libreria di Foto; il video va prima salvato in File.

## 3. Trascinamento da Foto — sorgente WebKit

File: `Source/WebCore/platform/ios/WebItemProviderPasteboard.mm`.

- ✅ `typeIdentifiersToLoad:` scorre i `registeredTypeIdentifiers` dell'`NSItemProvider` **nell'ordine dato dalla
  sorgente** (Foto) e carica il primo tipo «supportato» (highest fidelity) più il primo conforme a `public.content`; poi
  `loadFileRepresentationForTypeIdentifier:` e hard link in una cartella di staging. La pagina non può scegliere il tipo
  (non esiste un'API web per preferire `com.apple.quicktime-movie` a `public.mpeg-4`).
- ✅ Se i due tipi caricati sono diversi, lo stesso elemento può comparire come **più file** (`loadedFileURLs` = tutti i
  file caricati dell'item). ❓ Non osservato. L'app da v0.35.5 prende, fra i video con lo stesso nome base, il più grande.
- ❓ Quale rappresentazione Foto registri per un video (originale o esportazione «compatibile») e se dipenda da
  **Impostazioni › App › Foto › Trasferisci su Mac o PC: Automatico / Mantieni originali**. 🟡 Apple (HT 116944):
  quell'impostazione riguarda l'import via USB su Mac/PC («per non convertirli tocca Mantieni originali»); 🟡 un thread
  Apple Community (254741350) la suggerisce per il trascinamento Foto → File su iPad che riduceva i video (esito non
  chiaro). Da provare: è l'unica leva lato utente per il trascinamento.
- ❓ Con «Ottimizza spazio iPhone» (iCloud) l'originale può non essere sul telefono: Foto deve scaricarlo e potrebbe
  consegnare una versione diversa.

## 4. Misure su file reali (iPhone 17 Pro Max, iOS 27.0.1)

Stesso video IMG_2813 (creationdate 2026-11-18T23:40:14+0100) caricato due volte in chat dall'utente:

| | originale (12,2 MB) | copia «compatibile» (3,2 MB) |
|---|---|---|
| ordine tracce | **hvc1**, mp4a, **apac**, 6× mebx | **mp4a**, hvc1, 6× mebx (**apac assente**) |
| video | HEVC Main10 3840×2160 L5.1, 27,9 Mbps | HEVC Main10 **1920×1080** L5.0, 7,2 Mbps |
| DV / colore | dvvC 8.4 livello 9, HLG bt2020 | dvvC 8.4 livello 5, HLG bt2020 |
| moov/meta | make, model, software, creationdate | come a sinistra **+ `com.apple.quicktime.displayname` = "IMG_2813"** |
| mvhd creation | 22:40:14Z (= ripresa) | 22:40:35Z (**ora dell'esportazione**) |
| ftyp | `qt  ` | `qt  ` |

Anche `samples/IMG_7440.mov` ha la firma della copia (displayname, AAC prima, niente apac, mvhd 583 min dopo la
ripresa); `samples/IMG_2147.mov` e `IMG_2790` sono originali (video prima traccia, apac, nessuna displayname).

⇒ Regola in `app/lib/origin.js` (`judgeOrigin`, test `origin.test.mjs`): file Apple (make=Apple o nome IMG_xxxx) con
**displayname** oppure **audio prima del video** (oppure H.264 senza mebx) → «esportato». Osservazioni deboli (solo nota):
niente apac, niente mebx, HEVC 8 bit, mvhd lontano dalla creationdate (anche i video modificati in Foto, es. IMG_2147
tagliato, hanno mvhd successivo). ❓ La firma è stata vista su una sola coppia + un campione: confermarla con la pagina
diag sulle diverse vie di import.

## 5. Cosa cambia nell'app (v0.35.5)

- `accept` **invariato** (`video/*,.mov,.mp4`): nessun valore migliora la Libreria foto (§2.2); togliere i tipi video
  nasconderebbe la Libreria foto (scelta che resta utile per prove veloci). Testo sotto «Tocca per scegliere»: da «Scegli
  file» (app File) il video arriva intatto, da «Libreria foto» può arrivare una copia ricodificata.
- Avviso nella scheda del file quando `judgeOrigin` dice «esportato», con il percorso per l'originale; riga `origine:` nel
  log (categoria `warn`/`setup`).
- Trascinamento con più file dello stesso elemento: si prende il video più grande con lo stesso nome base.
- Pipeline di compressione non toccata.

## 6. Istruzioni per l'utente

1. **Via sicura**: Foto › apri il video › Condividi › **Opzioni** (in alto) › Formato **«Attuale»** › Fine ›
   **Salva in File** (es. «Sul mio iPhone»). Nella webapp: «Tocca per scegliere» › **Scegli file** › il video in File.
2. Da provare (❓): nel selettore «Libreria foto» di Safari tocca **Opzioni** › **Attuale** prima di «Aggiungi».
3. Da provare (❓) per il trascinamento: Impostazioni › App › Foto › Trasferisci su Mac o PC › **Mantieni originali**.
4. Trascinare da **File** (non da Foto) verso Safari consegna il file salvato così com'è.

Verifica: `https://deusares.github.io/finally-compress-video/tools/diag/import.html` — stesso video importato in ogni
modo (menu «Come stai scegliendo»), poi «Copia risultati».

## Fonti

- WebKit `WKFileUploadPanel.mm`: https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm
- WebKit `WebItemProviderPasteboard.mm`: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ios/WebItemProviderPasteboard.mm
- WebKit `WKContentViewInteraction.mm` (`fileUploadPanelPhotoPickerPrefersOriginalImageFormat`) e
  `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml` (`PhotoPickerPrefersOriginalImageFormat`, internal, false);
  `Source/WTF/wtf/PlatformEnableCocoa.h` (`ENABLE_TRANSCODE_UIIMAGEPICKERCONTROLLER_VIDEO`).
- Apple Developer Forums: «Prevent compression of video when uploading via mobile Safari?» https://developer.apple.com/forums/thread/731042 ·
  «How to influence 'Automatic' format selection of photos in iOS Safari photo picker?» https://developer.apple.com/forums/thread/743037 ·
  «Understanding PHPickerConfiguration.AssetRepresentationMode.current» https://developer.apple.com/forums/thread/736545 ·
  «PHPickerViewController Not Offering public.hevc UTI for a Known HEVC Video» https://developer.apple.com/forums/thread/791191
- Apple, Guida iPhone «Condividere foto e video» (Opzioni: Automatico / Attuale «evita una conversione del formato» /
  Più compatibile; «Tutti i dati delle foto» solo AirDrop): https://support.apple.com/guide/iphone/share-photos-and-videos-iphf28f17237/ios
- Apple, «Using HEIF or HEVC media on Apple devices» (Mantieni originali per l'import su Mac/PC; condivisione in formato
  più compatibile): https://support.apple.com/en-us/116944
- Apple Community «Videos get compressed when moving from Photos to Files app (iPad)»: https://discussions.apple.com/thread/254741350
- iDownloadBlog, opzioni di formato nel foglio di condivisione (iOS 17): https://www.idownloadblog.com/2023/09/20/how-to-convert-photos-videos-before-sharing-iphone/
