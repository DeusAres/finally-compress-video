# 05 — Esperimenti proxy (libx265 software come stand-in di VideoToolbox)

Script: `tools/lab/proxy_ladder.sh` (input: primi 4 s di IMG_7440, ref = decodifica lossless 10-bit FFV1). Metriche: SSIM (All/Y) e PSNR-Y vs originale decodificato. VMAF: vedi sezione dedicata in fondo (libvmaf 3.2.0).
Originale segmento: ~20.4 Mbps.

| Variante | target kbps | kbps reali | SSIM All | SSIM Y | PSNR-Y |
|---|---|---|---|---|---|
| GOP corto (keyint 28, come iPhone) | 4000 | 3713 | 0.9194 | 0.8851 | 32.40 |
| | 6000 | 5463 | 0.9414 | 0.9172 | 33.98 |
| | 8000 | 7187 | 0.9543 | 0.9359 | 35.19 |
| | 10000 | 8884 | 0.9627 | 0.9481 | 36.15 |
| GOP lungo (keyint 600) | 4000 | 3822 | 0.9251 | 0.8940 | 32.79 |
| | 6000 | 5683 | 0.9455 | 0.9236 | 34.36 |
| | 8000 | 7540 | 0.9573 | 0.9407 | 35.54 |
| | 10000 | 9377 | 0.9650 | 0.9518 | 36.50 |
| GOP lungo + hqdn3d leggero | 4000/6000/8000 | ≈ uguale | −0.001 vs GOP lungo | | |
| GOP lungo + atadenoise | 4000/6000/8000 | ≈ uguale | −0.001/−0.0015 | | |

**Osservazioni**
- GOP lungo: a parità di bitrate reale ~+0.3–0.4 dB PSNR ≈ **~6–10 % di bitrate risparmiato** (stima da pendenza curva). Guadagno reale ma moderato su 4 s; su clip lunghe e statiche cresce.
- Denoise: le metriche full-reference **penalizzano** il denoise (riferimento rumoroso) → conferma il problema metrico (vedi 06). Il beneficio va valutato con metrica vs sorgente filtrata + verifica visiva. Su questo clip diurno il rumore è basso.
- SSIM Y 0.95 vs originale si raggiunge ~9–10 Mbps (≈ −50/55 % vs 20.4 Mbps) con x265 *faster*. VideoToolbox HW è tipicamente meno efficiente di x265 → margine stretto: il −50 % richiede le leve combinate (per-scena, GOP, pre-filtro). VMAF (sezione sotto) conferma l'ordine di grandezza; ❓ da validare su device.
- Limite: un solo clip, 4 s, encoder proxy. Non rappresentativo di low-light.

## VMAF (libvmaf 3.2.0, commit cf677ba)

Build da sorgente Netflix (`meson setup build --buildtype release`, CLI `build/tools/vmaf`), eseguita con autorizzazione esplicita dell'utente. Script: `tools/lab/vmaf_score.sh <dist> <ref>` (entrambi convertiti in y4m yuv420p10le stessa dimensione; modelli `vmaf_v0.6.1` e `vmaf_v0.6.1neg` da file JSON in `model/`, perché la build locale non aveva i modelli built-in; stampa `vmaf_mean,vmaf_p5,neg_mean,neg_p5`, p5 = 5° percentile per-frame). Modello HDR presente nel repo (`model/hdr_vmaf_v1.1.8`, + `_hfr`), **non usato**.

> **Attenzione**: VMAF/VMAF-NEG sono addestrati su SDR (BT.709); applicati a HLG/BT.2020 codificato sono solo **indicativi** (ok per confronti relativi A/B e curve rate-quality, non per valori assoluti). Un solo clip per caso, 4 s (IMG_7440, 1080x1920 60 fps) / 3.5 s (IMG_2147).

IMG_7440 (originale ~20.4 Mbps; risparmio = 1 − kbps/20400):

| Variante | kbps reali | VMAF mean | VMAF p5 | NEG mean | % risparmio |
|---|---|---|---|---|---|
| GOP corto | 3713 | 82.07 | 63.31 | 80.15 | 81.8 |
| | 5463 | 89.70 | 73.08 | 87.81 | 73.2 |
| | 7187 | 94.05 | 79.23 | 92.42 | 64.8 |
| | 8884 | 96.35 | 83.80 | 95.18 | 56.5 |
| | 10598 | 97.62 | 87.21 | 96.80 | 48.0 |
| GOP lungo | 3822 | 84.70 | 64.48 | 82.75 | 81.3 |
| | 5683 | 91.73 | 75.09 | 89.91 | 72.1 |
| | 7540 | 95.16 | 80.14 | 93.84 | 63.0 |
| | 9377 | 96.92 | 84.29 | 95.99 | 54.0 |
| | 11215 | 97.94 | 87.56 | 97.24 | 45.0 |
| GOP lungo + hqdn3d | 3818 | 84.42 | 64.61 | 82.52 | 81.3 |
| | 5680 | 91.39 | 74.97 | 89.61 | 72.2 |
| | 7537 | 94.94 | 80.13 | 93.59 | 63.1 |
| GOP lungo + atadenoise | 3823 | 84.35 | 63.91 | 82.47 | 81.3 |
| | 5686 | 91.39 | 74.86 | 89.59 | 72.1 |
| | 7541 | 94.95 | 79.77 | 93.60 | 63.0 |

Bitrate per VMAF mean target (interpolazione lineare tra punti adiacenti):

| Target | GOP corto kbps (risparmio) | GOP lungo kbps (risparmio) | GOP lungo vs corto |
|---|---|---|---|
| VMAF 93 | ~6770 (66.8 %) | ~6370 (68.8 %) | −5.9 % |
| VMAF 95 | ~7890 (61.3 %) | ~7450 (63.5 %) | −5.5 % |
| VMAF 97 | ~9760 (52.2 %) | ~9520 (53.3 %) | −2.5 % |

IMG_2147 (1080p orizzontale 60 fps, 3.5 s, originale ~12.55 Mbps; **non low-light**: luma media ≈ 600/1023, HLG), GOP lungo:

| kbps reali | VMAF mean | VMAF p5 | NEG mean | % risparmio |
|---|---|---|---|---|
| 1439 | 68.07 | 35.78 | 66.07 | 88.5 |
| 2843 | 81.44 | 60.66 | 79.55 | 77.4 |
| 4278 | 87.66 | 74.36 | 85.85 | 65.9 |
| 5745 | 91.40 | 83.62 | 89.65 | 54.2 |

**Conclusioni**
- Su IMG_7440 VMAF 95 si ottiene a ~7.5 Mbps (GOP lungo) / ~7.9 Mbps (corto) = −63 % / −61 % vs originale; VMAF 97 a ~9.5–9.8 Mbps (≈ −53 %). Il target −50 % è ampiamente raggiungibile con x265 *faster* su questo clip.
- GOP lungo vale −5.5/−6 % di bitrate a VMAF 93–95, −2.5 % a 97 (il vantaggio si restringe verso l'alta qualità); coerente con la stima da PSNR.
- Denoise (hqdn3d/atadenoise): VMAF −0.3/−0.4 a pari bitrate (NEG idem), quindi nessun guadagno visibile sulle metriche FR; la verifica va fatta con metrica vs sorgente filtrata + ispezione visiva. VMAF-NEG è ~1–2 punti sotto VMAF ovunque, senza cambiare l'ordinamento delle varianti.
- Il p5 per-frame è 15–17 punti sotto la media (frame difficili/transizioni): per un controllo qualità conviene un vincolo sul p5, non solo sulla media.
- IMG_2147 (più difficile per bit/pixel, rumore/dettaglio maggiori) non raggiunge VMAF 95 nemmeno a 5.7 Mbps (91.4): servirebbero >~8–9 Mbps (stima, non misurata), cioè un risparmio ≲ 30–35 % per VMAF 95; il bitrate target va quindi adattato per scena. Misure indicative (SDR su HLG, x265 proxy, un clip per caso).

## Prima misura VMAF su output REALE dell'app (encoder Safari/VideoToolbox realtime) ✅
- File: samples/IMG_7440_hdr.mp4 (app v0.5–0.6, target 8 Mbps, GOP 4 s) vs IMG_7440.mov. Struttura: HEVC Main10, HLG BT.2020 tv-range, DV p8 compat 4, 522 frame, **solo I/P (3 I, 519 P, nessun B-frame)**, 8.18 Mbps video. Allineamento verificato (PSNR 120 frame: offset 0 → 35.4 dB, ±1 → 21.2 dB).
- **VMAF 88.86 (p5 73.07), VMAF-NEG 86.74 (p5 71.14)** a 8.2 Mbps (modello SDR su HLG: indicativo).
- Confronto proxy x265 faster (GOP lungo): VMAF 95 a ~7.5 Mbps. ⇒ **l'encoder Safari realtime è sensibilmente meno efficiente**: a parità di bitrate ~6 punti VMAF in meno. Per VMAF 95 serviranno verosimilmente ~12–15 Mbps su questo clip (−30/40 % invece di −63 %) — da misurare con la ladder 4/6/8/10/12/14 Mbps. L'obiettivo −50 % a VMAF 95 è a rischio con questo encoder; servono le leve (per-scena, GOP lungo, frame quasi-duplicati) e una decisione sulla soglia.
