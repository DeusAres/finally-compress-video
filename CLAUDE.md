# CLAUDE.md — regole di lavoro (Finally Compress)

Rispondi in italiano, diretto e tecnico. Usa subagenti quando possibile, con prompt ingegnerizzati per **minimo consumo di token e massima efficienza**.

**Agente principale sempre disponibile per parlare con l'utente**: delega il lavoro (codice, test, ricerche, analisi di log lunghe) a subagenti **in background** e resta libero per la conversazione. Inline solo ritocchi di pochi secondi (1–2 comandi) o il coordinamento (commit/push dei risultati, risposte).

## Subagenti: scelta del modello
| Compito | Modello |
|---|---|
| Ricerca file/simboli, lettura pagine web, riassunti, modifiche meccaniche (testo, CSS piccolo) | `haiku` |
| UI/CSS, documentazione, ricerca web con sintesi, test Playwright, refactor piccoli | `sonnet` |
| Debug di pipeline (WebCodecs, seek/rVFC, mux MOV/MP4, Dolby Vision, rate control), architettura, bug di correttezza | `opus` |

Mai Opus per ciò che Sonnet/Haiku fanno bene. Mai più agenti per lo stesso tema: continua quello esistente con SendMessage.

## Subagenti: struttura del prompt (sempre)
1. **Obiettivo** in 1–2 righe + **criterio di fatto** verificabile.
2. **Fatti già noti inline** (misure, log rilevanti, decisioni): l'agente NON deve riscoprirli.
3. **File precisi** da leggere, con funzione o intervallo di righe (`file.js` `nomeFunzione`, `index.html` ~righe 400–460). Vietato leggere interi `docs/BIBBIA.md`/`docs/research/*` salvo la sezione indicata (§n).
4. **Vincoli**: file che può/non può toccare (agenti in parallelo → file disgiunti), niente commit se un altro agente lavora sugli stessi file.
5. **Verifica mirata**: prima solo i test toccati (`node app/lib/x.test.mjs`), `tools/run-tests.sh` **una volta** alla fine. Playwright/screenshot solo se la modifica è visiva o di ciclo di vita.
6. **Rilascio** (se richiesto): `tools/stamp-version.sh <ver>` → commit (messaggio italiano + righe di attribuzione) → push `main` e branch di sviluppo.
7. **Rapporto**: max ~15 righe, in italiano: cosa è cambiato (file:riga), risultati misurati, cosa verificare su iPhone. Niente ripetizione del prompt né dump di codice.

Niente esplorazione libera del repo, niente installazioni non richieste, niente rifacimento di misure già nel prompt.

## Fatti di progetto (non riscoprire)
- App: `index.html` (radice, GitHub Pages da `main`), `app/lib/*` pipeline, `app/ui/*` interfaccia, `sw.js` offline, `tools/` laboratorio/diag/script. Rilascio: `tools/stamp-version.sh` timbra `?v=` (JS e CSS), `BUILD_ID`, `version.txt`, precache.
- Safari iOS 27: frame 10-bit solo da `<video>` seek + rVFC richiesto prima del seek; `VideoDecoder` dà 8 bit; encoder HEVC VideoToolbox realtime (rate control legato al tempo reale → controllo bitrate a circuito chiuso); downscale a 10 bit impossibile (research/14); PiP su `<video>` separato tiene viva la pagina (solo scheda Safari).
- File privati dell'utente (video caricati in chat) mai nel repo né nei commit.
- Test: `tools/run-tests.sh` (Node). Laboratorio VMAF: `tools/lab/vmaf_score.sh`.
