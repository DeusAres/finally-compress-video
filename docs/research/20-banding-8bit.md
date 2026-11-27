# 20 — Banding HLG 8 bit (c_hlg8) vs 10 bit, e mitigazioni

Misura di laboratorio (x265 come proxy di VideoToolbox), `tools/lab/banding.sh <clip> [s]`.

## Metodo
- Sorgente: HLG 10 bit 1080p, primi 2 s. Tutte le varianti a 8 Mbps (x265 `fast`, VBV 16 Mb, VUI BT.2020/HLG).
- m10 = Main10; trunc8 = troncamento a 8 bit senza dither (come il decoder Safari); dither8_ed/bayer = dither
  PRIMA dell'encoder (non realizzabile: il decoder tronca prima, solo riferimento); trunc8_deband / noise2 / noise4
  = mitigazione dopo il troncamento (ffmpeg `deband=thr 0.02:range 16:blur 1`, `noise alls=N:allf=t` temporale).
- CAMBI (Netflix, no-ref sul decodificato, più basso = meno bande; <5 trascurabile, >10 visibile, ~5 «leggermente fastidioso»,
  [cambi.md](https://github.com/Netflix/vmaf/blob/master/resource/doc/cambi.md)). VMAF/NEG contro sorgente 10 bit (indicativi: modello SDR).

## Risultati (CAMBI / VMAF)
| variante | IMG_2147 | IMG_7440 | P1 (privato, sorg. 5.79) | P2 (privato, sorg. 0.12) |
|---|---|---|---|---|
| sorgente 10 bit | 0.01 | 0.00 | 5.79 | 0.12 |
| m10 | 0.06 / 92.98 | 0.01 / 93.54 | 5.57 / 95.90 | 0.38 / 92.21 |
| trunc8 | 0.96 / 92.47 | 0.15 / 93.57 | 5.29 / 96.39 | 2.91 / 91.24 |
| dither8_ed (rif.) | 0.78 / 92.46 | 0.15 / 93.56 | 0.52 / 95.44 | 2.30 / 90.85 |
| trunc8_deband | 0.90 / 89.28 | 0.15 / 92.95 | 0.19 / 94.10 | 3.17 / 83.18 |
| trunc8_noise2 | 0.83 / 92.48 | 0.13 / 93.57 | n.m. | n.m. |
| trunc8_noise4 | 0.67 / 91.87 | 0.12 / 93.39 | 2.00 / 95.03 | 2.30 / 88.96 |
Bitrate reale 7.3-8.1 Mbps (noise4 +3-8%). Tutte le clip: stesso ordine di grandezza di bitrate fra varianti.

## Fonti sulle mitigazioni
- libplacebo `pl_shader_deband` (default iterations 1, threshold 3.0, radius 16, grain 4.0; media di 4 tap a raggio casuale
  crescente, accettata solo se |diff| < soglia/i; grain PRNG; «considera di ridurlo/disattivarlo per HDR»):
  [sampling.c](https://github.com/haasn/libplacebo/blob/master/src/shaders/sampling.c),
  [sampling.h](https://github.com/haasn/libplacebo/blob/master/src/include/libplacebo/shaders/sampling.h).
- f3kdb / flash3kyuu: confronto con pixel di riferimento entro `range`, soglie Y/Cb/Cr, grain statico o dinamico (`dynamic_grain`):
  [f3kdb docs](https://f3kdb.readthedocs.io/en/latest/usage.html), [neo_f3kdb](https://github.com/AmusementClub/neo_f3kdb).
- ffmpeg `deband`, `noise`: [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html#deband).

## Conclusioni
1. Il troncamento a 8 bit NON porta CAMBI sopra 5 in nessuna clip (max 5.29, dove la sorgente 10 bit ha già 5.79; peggior
   incremento: 0.12 -> 2.91). Soglia «visibile» (>10) mai vicina. Banding da 8 bit: misurabile ma sotto soglia; VMAF -0.5/-1 vs 10 bit.
2. Dopo il troncamento il dither non recupera i livelli persi; dà solo mascheramento. Il dither prima del quantizzatore (ed) è il
   solo che azzera davvero CAMBI (P1 5.3 -> 0.5), ma non è nostro: lo fa il decoder.
3. Deband emulato: abbassa CAMBI solo dove c'è banding in sorgente (P1 0.19) ma costa molto VMAF (-1.5...-8) e su P2 peggiora. Sconsigliato.
4. Grana temporale (noise4): CAMBI -20/30% e VMAF -0.5...-2.3, +3-8% bitrate a parità di tetto. Beneficio modesto, costo reale.

## Raccomandazione
Nessuna mitigazione di default su c_hlg8 (sotto soglia, 257 fps invariati). Se si vuole un'opzione: nel compute shader NV12
solo luma, rumore triangolare +-1 LSB 8 bit (ampiezza 1/255 in codifica limited), texture rumore blu 64x64 con offset casuale per frame,
modulato 0 nelle ombre (Y<~20/255) e dove la varianza locale 3x3 > 4 LSB; opzionale deband 4 tap, soglia 1.5/255, raggio 8 px, 1 iterazione.
Costo stimato +0.2-0.5 ms/frame (1 texture fetch + 4 tap) su 1.8 ms: ininfluente. Non attivare grain forte (>2 LSB): costa VMAF e bitrate.
Limiti: clip da 2 s, x265 non VideoToolbox, CAMBI su 8 bit riportati a 10 bit; verificare a occhio su cielo/gradienti in iPhone.
