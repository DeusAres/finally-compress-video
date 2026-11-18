# 11 - Eco/audio "doppio" dopo "Codifica contenuto multimediale" su video iPhone con audio spaziale (APAC)

Legenda: ✅ fonte letta (WebFetch riuscito) / 🟡 solo snippet dei risultati di ricerca / ❌ non trovato.
Nota: due pagine Apple Community (thread 255814016) hanno risposto HTTP 509, quindi lette solo come snippet.

## 1. Segnalazioni dello stesso problema
- ❌ Nessuna segnalazione trovata che colleghi esplicitamente Shortcuts "Encode Media" a eco/doppio audio con iPhone 17 Pro Max / APAC. Nessun thread Reddit r/shortcuts, MacRumors o GitHub pertinente emerso (ricerche: Encode Media + echo + spatial; export + APAC). Il fenomeno e' quindi non documentato pubblicamente (assenza di evidenza, non prova di assenza).
- 🟡 Il sintomo piu' vicino: eco dopo upload su Facebook di un video iPhone 16 con Spatial Audio; l'utente incolpa lo Spatial Audio, thread chiuso senza soluzione. https://discussions.apple.com/thread/255814016 (mirror: https://origin-discussions2-us-dr-prz.apple.com/thread/255814016). Una risposta suggerisce di scegliere in Foto il mix "In-Frame", che elimina l'eco su Facebook (🟡, solo snippet).
- 🟡 Adobe Premiere Rush con iPhone 17 Pro Max: lo staff consiglia di disattivare l'audio spaziale in Fotocamera. https://community.adobe.com/t/premiere-rush-discussions/iphone-17-pro-max/m-p/15617229 (snippet).
- 🟡 Topaz Labs, "[KNOWN ISSUE] iPhone 16 & iPhone 17 footage errors": workaround = esportare con Audio Mode "None" e riapplicare l'audio originale in un editor. https://community.topazlabs.com/t/known-issue-iphone-16-iphone-17-footage-errors/100269
- 🟡 Plex: eco quando un mp4 ha due tracce audio (AAC + AC3) riprodotte insieme; Jellyfin: due lingue insieme se entrambe marcate "default". https://forums.plex.tv/t/why-does-the-sound-echo-on-ios-and-apple-tv-4/146692 , https://forum.jellyfin.org/printthread.php?tid=7821 . Analogia, non APAC.
- 🟡 FFmpeg trac #1174: "iPod/iPad plays both audio tracks simultaneously" (gruppo alternativo con piu' tracce abilitate). https://lists.ffmpeg.org/pipermail/ffmpeg-trac/2012-April/005931.html

## 2. Struttura del file e possibili cause
- ✅ Shotcut forum: nel MOV iPhone 16 lo Stream #0:2 e' audio `apac` 4.0 canali 48 kHz; FFmpeg non ha decoder e il proxy fallisce. Fix in Shotcut 24.10 / workaround: Impostazioni > Fotocamera > Registra suono > Stereo. https://forum.shotcut.org/t/iphone-16-pro-videos-fail-to-create-proxy-files/46026
- 🟡 Struttura: traccia stereo AAC + traccia Spatial Audio APAC; diversi sviluppatori dicono che la APAC e' quella di default e fallisce nei player non Apple. (risultati su https://developer.apple.com/forums/thread/775865 e https://forums.plex.tv/t/plex-not-able-to-play-apac-apple-positional-audio/930308)
- ✅ Apple DTS (thread 775865, SDAVAssetExportSession/AVAssetWriter falliscono con iPhone 16 con audio spaziale): "molto probabile che il problema riguardi la gestione, da parte della libreria di terze parti, dei gruppi di tracce audio alternativi"; rimanda a TN3177. Nessuna soluzione confermata nel thread. https://developer.apple.com/forums/thread/775865
- ✅ Doc Apple `AVAssetExportSession.audioTrackGroupHandling` (iOS 16+): per default esporta solo le tracce abilitate del gruppo alternativo; `preserveAlternateTracks` le mantiene tutte; non si puo' impostare insieme a `audioMix` (eccezione). https://developer.apple.com/documentation/avfoundation/avassetexportsession/audiotrackgrouphandling.md
- 🟡 Un dev riporta che ri-codificare l'APAC fa perdere l'idoneita' allo spatial anche mantenendo la traccia metadati; DTS non conferma spiegazioni interne. (snippet su thread 775865)
- ❌ TN3177 non leggibile via WebFetch (solo titolo): https://developer.apple.com/documentation/technotes/tn3177-understanding-alternate-audio-track-groups-in-movie-files
- ❌ Nessuna fonte spiega i ~41.7 ms. Ipotesi NON verificata (mia): il render del mix spaziale (decoder/renderer APAC + Audio Mix) viene sommato alla traccia stereo; la latenza di ~40 ms e' compatibile con il ritardo del decoder/renderer, ma resta inferenza. Alternativa: il motore di Encode Media legge entrambe le tracce del gruppo alternativo e le mixa (comportamento tipo "preserveAlternateTracks"/due tracce abilitate).
- 🟡 Audio Mix funziona solo su clip registrate con Spatial Audio e dipende da metadati cinematic; iOS 26 lo estende oltre Foto. https://www.macrumors.com/2025/06/21/ios-26-audio-mix-beyond-photos-app/ , https://developer.apple.com/documentation/cinematic/editing-spatial-audio-with-an-audio-mix.md

## 3. Workaround noti
- Prevenzione alla sorgente: Impostazioni > Fotocamera > Registra suono > Formato audio = Stereo (anziche' Spaziale). ✅ (Shotcut) / 🟡 (Adobe, Apple Community 256165453 "Stereo e' la modalita' migliore" https://discussions.apple.com/thread/256165453).
- Mix "In-Frame" in Foto prima della condivisione: 🟡 (thread Facebook sopra).
- Estrazione solo AAC con ffmpeg (mia raccomandazione, non da fonte; verificare con ffprobe l'indice reale): `ffmpeg -i in.MOV -map 0:v:0 -map 0:a:N -c:v copy -c:a aac out.mp4` dove N e' la traccia AAC stereo (non apac). Evitare `-map 0:a` (itera anche tracce disabilitate: https://lists.ffmpeg.org/archives/list/ffmpeg-trac@ffmpeg.org/thread/LG427WOUOLTDCT45UQGOCJK2IPFUOSHJ/ 🟡). FFmpeg non decodifica la APAC Apple: nell'albero esiste un `apac` diverso ("Marian's A-pac"), non quello Apple (🟡 https://ffmpeg.org/doxygen/8.0/libavcodec_2apac_8c.html); richiesta di supporto aperta: https://ffmpeg.org/pipermail/ffmpeg-trac/2025-February/072813.html ✅ (solo intestazione ticket).
- Opzioni Encode Media: solo "Solo audio" (M4A) documentato 🟡 https://matthewcassinelli.com/actions/encode-media/ ; nessuna opzione audio per scegliere la traccia/gruppo.
- App terze/AVFoundation: usare AVAssetReader/Writer scegliendo una sola traccia del gruppo (suggerimento derivato dal thread DTS; non Apple-confermato). Topaz: Audio None + riattacco audio originale (🟡).

## 4. Riparazione a posteriori
- ❌ Nessuno ha documentato la riparazione di audio gia' "doppio". Un eco sommato a ritardo fisso (~41.7 ms) e' in linea di principio un comb filter: si puo' tentare la cancellazione con filtro inverso (`aecho`/`adelay` + sottrazione, o IIR y[n]=x[n]-g*y[n-d]), ma e' ipotesi mia non testata e rischia artefatti; il mix e' gia' fuso nell'AAC.
- Via piu' affidabile: rifare l'export dall'originale.

## 5. Bug noto Apple?
- ❌ Nessun Feedback ID, nessuna release note iOS 26/27 trovata che corregga il problema. Unico dato Apple correlato: thread DTS 775865 (gruppi alternativi). Un bug iOS 18 "silenzio audio con spatial" esiste ma e' un altro sintomo (🟡 https://techissuestoday.com/ios-18-bug-silences-iphone-16-videos-in-spatial-audio).

## Conclusioni operative
1. Prevenzione: registrare con Formato audio = Stereo (niente APAC/gruppo alternativo/Audio Mix); oppure, per clip gia' girate, ricodificare con sorgente che usi solo la traccia AAC.
2. Per i file gia' girati: ffprobe per elencare le tracce, poi estrarre/copiare video e mappare esplicitamente solo la traccia AAC stereo (`-map 0:a:N`), ricodificando il video separatamente; mai affidarsi a Encode Media su sorgenti con APAC finche' non verificato.
3. In alternativa, in Foto applicare Audio Mix "In-Frame"/Standard e fare export "bake-in" prima di Encode Media (da verificare, solo indizio da thread Facebook).
4. Riparazione dell'audio gia' doppio: solo da originale; il tentativo di cancellazione dell'eco a 41.7 ms e' sperimentale.
5. Se si sviluppa un export proprio (AVFoundation): leggere solo una traccia del gruppo alternativo (stereo), evitare `audioMix` insieme a `audioTrackGroupHandling`; segnalare ad Apple via Feedback Assistant con file di esempio.
