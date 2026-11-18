# 05 — Esperimenti proxy (libx265 software come stand-in di VideoToolbox)

Script: `tools/lab/proxy_ladder.sh` (input: primi 4 s di IMG_7440, ref = decodifica lossless 10-bit FFV1). Metriche: SSIM (All/Y) e PSNR-Y vs originale decodificato. **VMAF non disponibile**: build di libvmaf da sorgente negata dal classificatore permessi → serve OK utente (o eseguire VMAF altrove).
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
- SSIM Y 0.95 vs originale si raggiunge ~9–10 Mbps (≈ −50/55 % vs 20.4 Mbps) con x265 *faster*. VideoToolbox HW è tipicamente meno efficiente di x265 → margine stretto: il −50 % richiede le leve combinate (per-scena, GOP, pre-filtro). ❓ da validare con VMAF e su device.
- Limite: un solo clip, 4 s, encoder proxy. Non rappresentativo di low-light.
