# 21 — Pre-filtri SDR 8 bit (f_dn, f_jnd): peso a pari qualità

Domanda: quanto peso fanno risparmiare a pari VMAF la riduzione del rumore temporale (f_dn) e il filtro JND (f_jnd) di `tools/diag/sdr8.html` (?full)?

## Metodo (riproducibile)
- Script: `tools/lab/prefilter_bd.sh <clip> <nome> <dir> [N]` (riferimento, filtri, x265, VMAF), `tools/lab/prefilter_sdr.py` (porta numpy degli shader), `tools/lab/prefilter_bd.py` (BD-rate; `METRIC=vmaf_neg` per il NEG).
- Riferimento SDR: HLG → hable come `sdr8_score.sh` (zscale + tonemap, picco 10, nominale 100 nit), 1080p, 8 bit (RGB24 → yuv420p BT.709 tv), 180 frame a 60 fps (3 s) per clip.
- Shader portati fedelmente dal WGSL (`fsDn`, `jnd`): niente filtro ffmpeg equivalente (hqdn3d/atadenoise non hanno il peso `k·exp(-(Δluma·255/σ)²)` ricorsivo né il limite 0.6·JND con soglia da luminanza di sfondo + gradiente Sobel). dn: ricorsivo con storia in float, frame 0 senza storia; jnd: gaussiana 3×3 (1-2-1), bordi clamp. f_dn+f_jnd = dn poi jnd (combinazione non presente nella pagina).
- Codifica x265 `-preset fast`, `-b:v = maxrate = bufsize` a 2, 3.5, 5, 8 Mbps, uguale per tutte le varianti. VMAF e VMAF-NEG (modelli 0.6.1) contro il riferimento NON filtrato.
- 3 clip 1080p HLG iPhone: "scura" (poca luce, luma media ~6 %), "luce" (luminosa, movimento), "mista". Clip non nominate (file privati).

## Risultati
Variazione di VMAF a bitrate uguale (x265 raggiunge il bitrate richiesto in tutte le varianti: ±2 %), media sui 4 bitrate:

| variante | scura | luce | mista |
|---|---|---|---|
| f_dn σ4 k0.3 | -0.01 | -0.04 | -0.05 |
| f_dn σ4 k0.5 (app) | -0.05 | -0.17 | -0.60 |
| f_dn σ4 k0.7 | -0.52 | -0.04 | -0.92 |
| f_jnd cap 0.6 | +0.08 | -4.33 | -4.62 |
| f_dn 0.5 + f_jnd | +0.07 | -4.48 | -4.90 |

BD-rate vs base (positivo = servono PIÙ kbps a pari VMAF; media 3 clip, VMAF / VMAF-NEG):

| variante | BD-rate VMAF | BD-rate NEG |
|---|---|---|
| f_dn k0.3 | +0.5 % | +0.4 % |
| f_dn k0.5 | +2.3 % | +2.2 % |
| f_dn k0.7 | +12.9 % | +12.6 % |
| f_jnd | +19.8 % | +16.0 % |
| f_dn 0.5 + f_jnd | +22.4 % | +18.4 % |

Nessun filtro fa risparmiare peso. Attenzione: sulla clip scura la curva VMAF è quasi piatta (89.5 → 92.2 da 2 a 8 Mbps), quindi il BD-rate lì è instabile (dn k0.7: +32 %, jnd: -4 %); valgono i delta VMAF a bitrate fisso, che sono ≈ 0 (±0.1) per jnd/dn 0.3/0.5.

## Costo (iPhone, v1)
base b_eetf 98 fps, f_dn 84 fps (-14 %), f_jnd 55 fps (-44 %).

## Conclusione
- Con x265 (rate control a bitrate fisso) i filtri non liberano bitrate misurabile: il VMAF contro la sorgente non filtrata scende o resta uguale, mai sale. Il JND con cap 0.6 toglie 4-5 punti VMAF sulle clip con dettaglio e costa il 44 % di fps: da scartare. Il denoise temporale è neutro a k ≤ 0.5 (k 0.3 praticamente un no-op) e dannoso a k 0.7.
- Limite del test: VMAF misura la fedeltà alla sorgente, quindi penalizza per costruzione ogni denoise; sul rumore di sensore forte (low-light a ISO alta) un guadagno percepito è possibile ma non dimostrato qui (la clip scura è poco rumorosa). Il VideoToolbox realtime ha un rate control diverso: il guadagno reale potrebbe esserci solo se il codificatore spreca bit sul rumore.
- Raccomandazione: NON portare f_jnd; NON portare f_dn come default. Al massimo f_dn (σ4, k 0.3-0.5) come opzione sperimentale spenta, da validare su iPhone con una clip davvero rumorosa e bitrate reale del codificatore (dimensione file a parità di aspetto) prima di qualsiasi integrazione.
