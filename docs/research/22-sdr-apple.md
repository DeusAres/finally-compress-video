# 22 — SDR come la conversione «compatibile» di Apple

**Domanda**: quale via HLG → SDR 8 bit si avvicina di più all'export «compatibile» di Apple (Foto)? Curve nostre, 3D LUT, o la conversione del sistema in Safari («sys»)?

**Banco** (`tools/lab/sdr_apple_lab.py`): clip iPhone HLG Dolby Vision 8.4, 1080p30, 1 s (30 frame) + la stessa clip esportata da Apple (H.264 BT.709). Frame allineati per pts (identici) e nello spazio (correlazione massima a spostamento 0,0). Misure su tutti i 30 frame a mezza risoluzione, stessa decodifica per tutti (BT.709 limitato, γ 2.4, D65). Le nostre varianti usano la matematica dello shader (`sdr8_tm_metrics.py`) su ingresso 8 bit come `VideoDecoder`.

| via | ΔE00 medio | ΔE00 p95 | \|ΔY\| (codici 8 bit) | C\* / Apple |
|---|---|---|---|---|
| hable (curva più vicina) | 6.30 | 10.51 | 13.3 | 1.01 |
| hlgsdr | 9.39 | 15.79 | 22.2 | 1.00 |
| «apple» v2.2 | 9.77 | 16.56 | 23.9 | 0.98 |
| bt2408 | 13.90 | 23.50 | 36.4 | 1.12 |
| bt2446c | 19.67 | 32.73 | 54.3 | 1.25 |
| **3D LUT 33³**, adattata sui frame pari, misurata sui dispari | **1.51** | **3.40** | 1.1 | 0.99 |
| **3D LUT 33³**, adattata sulla 1ª metà, misurata sulla 2ª | **1.53** | **3.44** | 1.1 | 1.01 |
| sys (Safari, `drawImage` su canvas sRGB) | da misurare su iPhone | | | |

**Curva luma** (mediana di Y' d'uscita per Y' HLG d'ingresso): Apple è quasi lineare nel segnale: Y' HLG 0.16 → 47, 0.53 → 120, 0.78 → 170, 0.97 → 228. Hable coincide da 0.6 in su ma ha ombre più scure (−15…−20 codici sotto 0.3). bt2408 e «apple» v2.2 sono più chiari di 30–50 codici nei medi e comprimono le alte luci (Y' ≥ 0.66 → 187–214): per questo sembrano slavati rispetto ad Apple. Saturazione: Apple ≈ Hable (C\* 1.01). bt2408 satura il 12 % in più.

**Cosa fa Apple**: nella clip è una **mappa globale fissa** per pixel. Una LUT 3D senza contesto spaziale riproduce frame mai visti con ΔE 1.5 (rumore H.264 compreso). Non c'è tone mapping locale. Non c'è adattamento nel tempo misurabile (la LUT della 1ª metà vale per la 2ª). Il reshaping Dolby Vision dell'RPU è identico in tutti i frame. ffmpeg 6.1 non decodifica i blocchi L1/L2, quindi resta **non verificato** se Apple adatti la mappa per scena tra clip diverse: serve una clip lunga con scene diverse e il suo export.

**Via «sys»** (`tools/diag/sdr8.html` v2.3, predefinita): `<video>` seek + rVFC a 2 player (`parallelFrames`) → `drawImage` su canvas 2D sRGB → `VideoFrame(canvas)` → encoder 8 bit → `b_sys_8M.mp4`. Il frame centrale va in `tm_compare.png` (sys, LUT, Hable, BT.2408, Apple-like). Senza Safari non si misura qui. Su iPhone: `python3 -I tools/lab/sdr_apple_lab.py HDR.mov EXPORT_APPLE.mov b_sys_8M.mp4` aggiunge la riga ΔE di sys (i frame sono confrontati per indice). Chromium headless non converte HLG, quindi il test verifica solo la logica.

**Via «lut»** (`vendor/lut/apple_hlg_sdr33.bin`, 211 KB): 33³ × RGB uint16 LE, ordine r, g, b. L'ingresso è HLG R'G'B' (BT.2020), l'uscita SDR R'G'B' BT.709. Nello shader è una texture 3D `rgba16float` con campionamento trilineare (`?tm=lut`, solo percorso NV12). Il costo è quello di una curva. Adattamento: splat iterativo ai nodi (≈ minimi quadrati). Nei nodi senza dati resta la curva Hable.

**Limite della LUT**: è adattata su **una** clip di 1 s. I colori assenti (es. magenta saturi molto chiari) restano Hable, con possibili cuciture. Si può allargare con altre coppie originale/export Apple: si rilancia lo script con `--lut`.

**Raccomandazione**:
1. **Ora: LUT.** Porta ΔE da 6.3 (curva migliore) a 1.5, alla velocità del percorso veloce (~250 fps a 1080p).
2. **sys** vale solo se su iPhone misura ΔE ≤ ~1.5. Due argomenti a favore: sarebbe la conversione di Foto per costruzione, e lavora da frame a 10 bit. Costa però il percorso seek (~100 fps, cioè ~2.5× più lento) e l'uscita passa da un canvas sRGB (transfer sRGB etichettato BT.709).
3. **Decisione** dopo la misura di sys sull'iPhone (riga `b_sys_8M.mp4` dello script e fps di `b_sys@8` contro `b_lut@8`). Nelle stesse corse, ripetere la verifica della LUT su un secondo video con il suo export Apple.
