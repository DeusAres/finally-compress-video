# 06 – Algoritmi percettivi: pre-encoder su GPU + ricerca bitrate a circuito chiuso

Data: 2026-11-18. Contesto: encoder HEVC hardware (VideoToolbox via WebCodecs) come scatola nera; leve disponibili = pixel in ingresso, bitrate per segmento, posizione dei keyframe. Target 1080p60 10-bit HLG su iPhone, WebGPU/WGSL.

## Onestà sullo stato delle fonti

Legenda: ✅ fonte primaria letta; 🟡 fonte secondaria o abstract/snippet letto; ❓ da verificare/testare (citato a memoria o non verificato).

Aggiornamento 2026-11-18 (verifica fonti, vedi sezione finale): abstract letti (non i paper interi) per Chou&Li, Yang 2005, Vanam&Reznik (solo metadati), Amazon EA-MCTF, Xie EMCTF, PU21 (abstract dal PDF), ColorVideoVDP, FUNQUE, VMAF NEG/hacking, CAMBI. ✅ = abstract/pagina primaria letta con i dati citati. Le cifre ancora ❓ restano ordini di grandezza da misurare sul nostro encoder. Il blog Netflix (Dynamic Optimizer) non è stato raggiungibile (HTTP 403): le cifre Netflix sono **non confermate**.

Considerazione generale sul target −50%: i guadagni pubblicati per pre-filtraggio puro sono tipicamente 5–20% a qualità percettiva uguale; per ottimizzazione per-scena 10–30% rispetto a un bitrate fisso ben scelto (❓ ordine di grandezza; le cifre Netflix riportate da fonti secondarie, 28–38% per codec, non sono confermate sul blog primario). Il −50% è realistico solo se il bitrate di partenza è molto sovradimensionato (es. ~50 Mbps da camera iPhone) oppure se il contenuto è rumoroso (low-light), dove denoise + bitrate-search pesano molto. Va misurato sul baseline reale.

---

## 1. Pre-filtraggio percettivo basato su JND

**Fonti**
- ✅ (metadati/abstract) Chou & Li, "A perceptually tuned subband image coder based on the measure of just-noticeable-distortion profile", IEEE TCSVT 5(6):467–476, dic. 1995, DOI 10.1109/76.475889. Profilo JND per sottobanda da soglie di luminanza di sfondo e texture masking; introduce PSPNR (peak signal-to-perceptible-noise ratio). Abstract: "near-transparent" coding, nessun numero di bitrate. (La formula "max" precedente era scritta a memoria: non confermata dall'abstract.)
- ✅ (abstract/metadati) Yang, Lin, Lu, Ong, Yao, "Motion-compensated residue preprocessing in video coding based on just-noticeable-distortion profile", IEEE TCSVT 15(6):742–752, 2005, DOI 10.1109/TCSVT.2005.848313 (autori corretti: Yang, Lin, Lu, Ong, Yao; NON "Ping" come cognome). JND stimato nel dominio immagine con NAMM (nonlinear additivity model for masking; NAMM era già in un ICIP 2003 degli stessi autori), applicato al residuo di moto compensato. Implementato in MPEG-2 TM5: +0.505 dB PSNR medio su 20 sequenze. La forma JND = T_lum + T_tex − C·min(·) con C≈0.3 è dalla memoria: non confermata qui.
- Wei & Ngan, "Spatio-temporal just noticeable distortion profile for grey scale image/video in DCT domain", IEEE TCSVT 19(3), 2009 (❓). JND DCT-domain con CSF, luminanza, contrasto/edge, temporale.
- Wu et al., "Perceptual visual signal compression and transmission", Proc. IEEE 101(9), 2013 (❓): survey utile.
- ✅ (titolo/metadati) Vanam & Reznik (InterDigital), "Perceptual pre-processing filter for user-adaptive coding and delivery of visual information", PCS 2013, San Jose, pp. 426–429, DOI 10.1109/PCS.2013.6737774. Titolo corretto. Filtro basato su CSF che dipende da distanza di visione e densità di pixel, rimuove dettaglio non percepibile; nessuna cifra di bitrate letta (lavori successivi: Kerofsky, Vanam, Reznik GlobalSIP 2014, ICIP 2014; brevetto US10045050B2). Cifra "10–30%" precedente: non confermata.
- 🟡 "JND-Guided Perceptual Pre-filtering for HEVC Compression of UHDTV Video Contents" (HAL hal-03565787; autori/venue non letti, pagina bloccata): da snippet di ricerca, risparmio fino al 23% a pari qualità percepita (non BD-rate; valutazione soggettiva). Correlato: filtri BilAWA/TBil guidati da JND (Image Communication, 2017), media 19.3% (fino a 28.7%) su H.264/AVC a pari qualità percepita (snippet). Un lavoro 2025 (arXiv 2510.10648) osserva che questi lavori raramente usano BD-rate e riporta −4.84% BD-BR VMAF per un pre-filtro neurale, all-intra (snippet).
- Pre-filtri JND per codec moderni / learning-based: Ki et al., "Learning-based just-noticeable-quantization-distortion modeling for perceptual video coding", IEEE TIP 2018 (❓).

**Principio.** Calcolare una mappa JND(x,y,t) (ampiezza massima di modifica non visibile) e applicare al frame una modifica vincolata: p' = p + clip(f(p) − p, −JND, +JND), dove f è un filtro (smoothing/denoise). Si riduce energia ad alta frequenza invisibile e l'encoder spende meno bit su residuo/coefficienti.

**Guadagni misurati.** Yang 2005: +0.505 dB PSNR medio a pari bitrate su MPEG-2 TM5 (✅ abstract; non una % di bitrate). Il "10–30%" scritto prima per Yang/Vanam è **non confermato**. Valori letti solo da snippet: fino al 23% (JND pre-filter HEVC UHD, soggettivo) e ~19% (AVC, soggettivo). Metrica spesso PSNR/test soggettivo, **non** BD-rate con VMAF. Nessuna misura pubblicata su encoder HEVC hardware.

**Costo.** Pixel-domain: per pixel una convoluzione per gradiente (Sobel 3x3/5x5 su luma), una LUT per luminanza, un max/blend. ~100–200 FLOP/pixel; a 124 Mpix/s ≈ 12–25 GFLOPS: fattibile su GPU iPhone (A17/A18 ~2 TFLOPS FP32). DCT-domain: blocchi 8x8, più costoso e inutile per HEVC (TU 4–32) — preferire pixel-domain.

**Rischi.** Il JND pubblicato è calibrato su SDR gamma e display ~100 nit, osservazione a distanza fissa: va ricalibrato per HLG/HDR e per display iPhone (vedi §3). Soglia "just noticeable" ≠ "visually lossless in confronto A/B"; usare un fattore di sicurezza (es. 0.5–0.7·JND). Il filtraggio alle soglie rischia banding (§9).

**Idoneità GPU.** Ottima: tutto locale (stencil), un compute pass. Moltiplicare la modifica per mappa JND è banale. ✅ idoneo; ❓ per calibrazione.

---

## 2. Mascheramento temporale / da movimento

**Fonti**
- Kelly, "Motion and vision. II. Stabilized spatio-temporal threshold surface", J. Opt. Soc. Am. 69(10), 1979 (❓). CSF spazio-temporale con occhio stabilizzato; la sensibilità dipende dalla **velocità retinica**, non da quella sullo schermo.
- Daly, "Engineering observations from spatiovelocity and spatiotemporal visual models", Proc. SPIE 3299, 1998 (❓). Modello spatio-velocity CSF e compensazione del tracking oculare (smooth pursuit, efficienza ~0.82, massimo ~80°/s, ❓ parametri).
- Wei & Ngan 2009 (vedi §1): componente temporale del JND.
- ColorVideoVDP (§8) implementa canali temporali e CSF dipendente da frequenze spaziali e temporali, ✅ https://arxiv.org/abs/2401.11485.

**Principio.** La sensibilità al dettaglio fine cala con la velocità retinica *non compensata*. Se l'occhio insegue un oggetto, l'oggetto è stabilizzato sulla retina (dettaglio visibile) e lo sfondo scorre (dettaglio invisibile). Per un pre-filtro: smussare di più regioni con alto moto locale **non seguibile** (sfondo in panning, foglie, acqua), ma non l'oggetto inseguito (tipicamente il moto dominante/ROI). Euristica: moto globale (panning) = occhio che insegue ⇒ sfondo a moto globale è nitido per l'osservatore; oggetti a moto diverso dal globale sono quelli sfocabili.

**Guadagni.** Letteratura JND temporale: ordine 5–15% in più rispetto a JND solo spaziale (❓ nessuna cifra verificata). Nessuna cifra per HEVC hardware.

**Costo.** Richiede campo di moto (§4); il resto è una LUT 2D (frequenza spaziale × velocità) per peso. Il costo dominante è la stima di moto, già necessaria per MCTF.

**Rischi.** Smooth pursuit non osservabile: il modello sbaglia se l'utente guarda lo sfondo. Rischio di sfocare oggetti in primo piano in movimento che l'utente segue (volti in movimento). Per questo meglio usare il mascheramento temporale come modulatore conservativo (cap sul fattore di blur). Errori di flusso ottico creano flicker.

**Idoneità GPU.** Buona (peso per-pixel da flusso). ❓ calibrazione.

---

## 3. Mascheramento da texture, luminanza (Weber) e dominio HLG/HDR

**Fonti**
- Legge & Foley, "Contrast masking in human vision", JOSA 70(12), 1980 (❓); Watson & Solomon, "Model of visual contrast gain control and pattern masking", JOSA A 14(9), 1997 (❓): divisive normalization.
- Watson, "DCTune", SID 1993 (❓); Ponomarenko et al., "On between-coefficient contrast masking of DCT basis functions" (PSNR-HVS-M), VPQM 2007 (❓).
- ✅ Mantiuk & Azimi, "PU21: A novel perceptually uniform encoding for adapting existing quality metrics for HDR", PCS 2021, https://www.cl.cam.ac.uk/~rkm38/pdfs/mantiuk2021_PU21.pdf (codice https://github.com/gfxdisp/pu21). Abstract: basato su un modello di CSF recente, fittato fino a 10 000 cd/m²; modella artefatti di codifica realistici e il glare; migliora la correlazione con i soggetti di PSNR, VSI, FSIM, SSIM, MS-SSIM sul dataset UPIQ. (Il range "0.005–10000" scritto prima non è nell'abstract: non confermato; una fonte secondaria dà 0.0002–10000 cd/m² per la CSF sottostante.)
- SMPTE ST 2084 (PQ, basato su Barten) e ITU-R BT.2100 (HLG), ITU-R BT.2408 (guida operativa HLG, riferimento 203 cd/m² per HDR reference white / 75% HLG) (❓).

**Principio.**
- Weber: ΔL/L ≈ costante (~1–2%) in fotopico, soglia assoluta più alta a luminanze basse (de Vries–Rose). PQ è una codifica JND-based; HLG no (è relativa alla scena, con OETF a due rami: sqrt per basse luci, log per alte luci).
- Texture masking: il contrasto di una regione tessiturata maschera distorsioni a frequenze simili; regioni piatte e bordi netti no (Yang 2005 attenua il mascheramento sui bordi).

**Come applicare in HLG.** Pipeline per calcolare il JND: (1) HLG → luce di scena lineare (inverse OETF) → OOTF con gamma di sistema (≈1.2 a 1000 nit; per display iPhone luminosità variabile ❓) → luminanza display assoluta L in cd/m²; (2) PU21 (o PQ) su L → spazio ≈ uniforme in JND: differenze di 1 unità ≈ soglia; (3) calcolare gradiente/contrasto locale **in questo spazio**: lì il JND è circa costante in ampiezza, semplificando la soglia (T ≈ costante·fattore di texture). Applicare la modifica in HLG con la Jacobiana locale (LUT 1D per dHLG/dPU). In pratica: LUT 1D a 1024 entry (HLG10 → PU21) e inversa.

**Guadagni.** Non misurati separatamente; sono componenti del JND (§1).

**Costo.** LUT + stencil; trascurabile.

**Rischi.** Luminosità display variabile (auto-brightness, EDR headroom) cambia la soglia: scegliere conservativo (luminanza di picco più alta ⇒ soglie di contrasto più strette nelle alte luci). Ombre: il rumore a bassa luminanza in HLG è amplificato dal ramo sqrt e il display le mostra a bassa sensibilità; rischio banding se si smussa troppo (§9). PU21 non è stato validato per tutte le condizioni di visione ❓.

**Idoneità GPU.** Ottima.

---

## 4. Denoising temporale compensato in moto (MCTF) e filtri leggeri GPU

**Fonti**
- MCTF/"temporal filter" in HM/VTM (encoder-side pre-filter su frame chiave/GOP, 4 vicini ±2 con pesi dipendenti dall'errore di blocco). 🟡 Origine: Wennersten, Sjöberg, Enhorn, "AHG10: Encoder only GOP based temporal filter", JVET-O0549, Göteborg, luglio 2019 (da snippet); pulizia: JVET-Y0155 (Bossen). Ericsson "Improvements of the temporal filter in video coding" (IEEE, https://ieeexplore.ieee.org/document/9937263; pagina non leggibile): modifiche a motion estimation, più frame vicini, pesi da errore di blocco; risultati su VTM-14.0 CTC, **cifre BD-rate non lette**.
- ✅ (abstract via ricerca) Xie, Wang, Li, Zhang, Zhang, Wang, "Enhanced Motion Compensated Temporal Filter for VVenC", IEEE TCSVT 34(11), 2024, pp. 12086–12091 (DOI 10.1109/TCSVT.2024.3393721): BD-rate −0.85/−0.91/−0.85/−0.82% su faster/fast/medium/slow rispetto al MCTF base di VVenC (multi-hypothesis reference, varianza MV, complessità di texture). Metrica BD-rate non specificata nell'abstract.
- ✅ (abstract) Vanam & Sethuraman (Amazon Prime Video), "Improving compression efficiency using an encoder-aware motion compensated temporal filter", DCC 2023, https://www.amazon.science/publications/improving-compression-efficiency-using-an-encoder-aware-motion-compensated-temporal-filter (versione SPIE 12674: "Encoder-aware motion compensated temporal filtering for video compression"). **CORREZIONE: l'URL arXiv 2407.12465 era sbagliato** (è "Enhancing Film Grain Coding in VVC", Menon et al.). Risultati: x265, slow, GOP 16, CRF 19–20.5, 10 clip 1080p SDR 8-bit; BD-rate **VMAF** medio −12.4% (picco −50.6%) per EA-MCTF vs non filtrato; HM-MCTF −1.9% medio con perdite su molte clip; overhead di encoding +17% (EA) vs +784% (HM-MCTF). Il −12.4% è su soli 10 clip e su VMAF (non PSNR).
- Opzioni di encoder con temporal filter: VVenC `--mctf`, SVT-AV1 `--enable-tf` (alt-ref temporal filtering, default on) (❓ nomi esatti), x265 (versioni recenti hanno `--temporal-filter`/MCSTF, ❓).
- Filtri leggeri: bilateral (Tomasi & Manduchi 1998), guided filter (He, Sun, Tang, "Guided image filtering", IEEE TPAMI 2013, ❓), NLM (Buades et al. 2005, ❓), BM3D (Dabov et al. 2007, ❓; troppo pesante), VBM4D (Maggioni 2012, ❓; troppo pesante), flusso ottico denso: DIS (Kroeger et al., ECCV 2016, ❓) adatto a GPU, block matching gerarchico (più semplice).

**Principio.** Media temporale pesata lungo traiettorie di moto: il rumore del sensore (incorrelato) si riduce di ~√N, il segnale resta. Il codec spende meno sul residuo. Pesi per blocco in funzione dell'errore di allineamento (SAD): se il match è cattivo, peso ≈ 0 (evita ghosting).

**Guadagni.** MCTF "ufficiale" in VTM è un pre-filtro di sorgente il cui scopo è guadagno al lato codifica rispetto al riferimento *non filtrato* (la CTC lo misura così): ordine 1–3% (HM-style −1.9% BD-rate VMAF su x265 da Amazon, ✅; per VTM non trovato un numero JVET: **non confermato**; Xie 2024: ulteriore −0.8/0.9% su VVenC). Gli −12.4% medi (picco −50.6%) di Amazon EA-MCTF sono VMAF su 10 clip, non generalizzabili al low-light; ci aspettiamo 20–40% su video notturni (❓ stima mia, da misurare).

**Costo.** Hierarchical block matching su luma 1/2 o 1/4 risoluzione + warp + media su 2–4 frame: ~50–150 FLOP/pixel; memoria: tenere 3–5 frame in texture 10-bit (rgba16float o r16uint). 1080p60 fattibile; il collo di bottiglia è la banda memoria, non l'ALU. Guided filter O(1) per pixel con box filter separabili: pochi pass. Alternativa economica: filtro **ricorsivo** (IIR temporale) con peso adattivo al moto: 1 frame di storia, nessun lookahead, ma ghosting se la stima del movimento è cattiva.

**Rischi.** Ghosting/smearing su occlusioni, pulsazione del filtro, perdita di micro-dettaglio ("plastic", §9), latenza se si usano frame futuri (OK: offline/near real-time con buffer di 2–4 frame).

**Idoneità GPU.** Alta per block matching e warp; il flusso denso (DIS) è fattibile ma più complesso. Tutto in compute shader.

---

## 5. Rimozione grana + sintesi

**Fonti**
- Norkin & Birkbeck, "Film grain synthesis for AV1 video codec", DCC 2018 (❓, non verificato).
- Norkin, Gomila, Pu et al., modello di film grain nell'SEI di H.264/HEVC (SEI film grain characteristics, payloadType 19) (❓).
- Netflix Tech Blog, "Film grain synthesis for AV1" (❓ non verificato in questa sessione): cifra "≥30%" **non confermata**. Nota: "Enhancing Film Grain Coding in VVC" (Menon et al., arXiv 2407.12465, IBC 2024; ✅ abstract) descrive analisi/sintesi grana in VVenC/VVdeC via SEI, senza BD-rate nell'abstract.

**Principio.** Denoise la sorgente, codifica pulito, trasmette parametri (modello autoregressivo + scaling per intensità) e risintetizza grana nel decoder.

**Guadagni.** Rilevanti su film grain (decine di %), ❓ per rumore sensore iPhone.

**Idoneità qui.** **Bassa.** (a) Il bitstream finale è HEVC dal VideoToolbox: non possiamo inserire SEI film grain tramite WebCodecs (l'encoder emette solo ciò che produce) e comunque non risulta che i decoder Apple (VideoToolbox HEVC) applichino HEVC FGC SEI ❓ (probabilmente no). (b) AV1 film grain è nello standard AV1 e il decoder deve applicarlo, ma l'encoder AV1 hardware su iPhone dipende dal chip e WebCodecs; non è il nostro codec target. Conclusione: **rimuovere** il rumore (denoise parziale) senza risintesi; oppure risintetizzare dopo il decode lato player (richiede un player nostro WebGPU, ❓ fuori scope se il file deve restare standard).

**Rischi.** Senza risintesi: look "pulito/plastico" (§9). Per limitare, denoise parziale (blend 60–80%) e/o re-aggiunta di micro-grana a bassa ampiezza *dopo* l'encoder non è possibile → compromesso nello sbiadimento.

---

## 6. Encoding per shot/scena, convex hull, scene-cut, GOP lunghi

**Fonti**
- Katsavounidis (con Guo), "Dynamic optimizer – a perceptual video encoding optimization framework", Netflix Tech Blog, marzo 2018 (❓ non letto: netflixtechblog.com risponde 403). Fonti secondarie (non primarie): Netflix "fino al 19%" di banda/storage vs versione visivamente indistinguibile (stampa); altra fonte secondaria: −28.04% x264, −37.61% libvpx VP9, −33.51% x265 in VMAF a pari qualità (da un articolo secondario, non verificato sul blog né sul paper).
- Aaron, Li, Manohara, De Cock, Katsavounidis, "Per-title encode optimization", Netflix Tech Blog 2015 (❓).
- Reznik et al., "Optimal design of encoding profiles for ABR streaming", PV 2018 (❓).
- Catalogo di scene-cut: rilevazione tramite differenza di istogramma/SAD su luma ridotta, come in x264/x265 `--scenecut` (❓).

**Principio.** Segmentare in shot; per ogni shot, provare più (risoluzione, bitrate) e costruire il convex hull RD (metrica percettiva vs bitrate); scegliere il punto che equalizza la pendenza (dQ/dR) tra shot sotto un vincolo di bitrate totale (Dynamic Optimizer). Per noi: stessa idea ma con una sola risoluzione e un solo codec: **allocazione di bitrate per segmento a pendenza uguale**.

**Guadagni.** Per-title: ordine 20% medio (❓ non confermato). Dynamic Optimizer: 28–38% su x264/VP9/x265 (🟡 solo fonte secondaria, VMAF; **non confermato** sul blog primario) e "fino al 19%" in altra fonte secondaria: i due numeri non sono conciliabili senza leggere il blog (baseline diversi). Non sono guadagni "a pari bitrate fisso ottimo per ogni contenuto": per un confronto equo col nostro baseline serve misurare. GOP lungo: passare da keyframe ogni 1–2 s a ogni scena (o 5–10 s) dà ordine 3–8% (❓ stime di letteratura; nel nostro caso WebCodecs permette di forzare keyframe con `keyFrame:true`, quindi il piazzamento sulle scene-cut è fattibile).

**Costo.** Closed-loop = encodes ripetuti. Con encoder hardware ~realtime o più veloce di realtime (VT HEVC 1080p: tipicamente ≫60 fps ❓), si possono fare 3–6 passate per segmento; la metrica deve costare meno dell'encode. Strategia: scegliere 3 bitrate candidati per scena, misurare qualità su subset di frame (es. 1 su 8) e su crop/downscale; interpolare la curva RD (monotona) e scegliere con bisezione.

**Rischi.** Hardware encoder CBR/VBV: il bitrate reale per segmento può deviare dal target, rate control dell'encoder HW con lookahead limitato (picchi su scene-cut); instabilità qualitativa fra segmenti. Cambi di bitrate per segmento visibili come "pompaggio" se la pendenza non è uniforme; usare smoothing/limiti ±15% fra scene adiacenti.

**Idoneità GPU.** La logica è CPU/JS; la metrica su GPU (§8).

---

## 7. ROI / salienza (volti) senza mappa QP

**Fonti**
- Hadizadeh & Bajić, "Saliency-aware video compression", IEEE TIP 23(1), 2014 (❓).
- Lee & Bovik et al., codifica foveata (❓).
- Face detection: Vision framework (iOS) o modello leggero (BlazeFace, Bazarevsky et al. 2019, ❓).

**Principio.** Un encoder senza QP map si comporta in modo uniforme sulla distribuzione dei bit. Pre-filtro **differenziale**: smoothing/denoise più forte fuori ROI (sfondo), nullo sui volti. Riduce residuo fuori ROI ⇒ l'encoder (a bitrate costante) ridistribuisce i bit su volti e dettagli salienti.

**Guadagni.** Letteratura: 10–20% di bitrate a parità di qualità sulla ROI (❓), qualità percepita di sfondo diminuita.

**Costo.** Salienza: modello leggero per frame (CPU/ANE) o rilevamento volti ogni N frame + tracking; sul GPU solo la maschera morbida (blur della maschera) e il blend.

**Rischi.** Transizioni di maschera visibili (alone intorno al soggetto), flicker della maschera fra frame (usare smoothing temporale e feather ampio); sfocatura dello sfondo percepita come effetto "ritratto" innaturale se eccessiva; falsi negativi del rilevatore.

**Idoneità GPU.** Alta per l'applicazione; il rilevamento sta fuori (Vision/CoreML).

---

## 8. Metriche percettive per il controllo a circuito chiuso

| Metrica | Fonte (stato) | Costo | HDR/tempo | Note |
|---|---|---|---|---|
| PSNR / PU21-PSNR | Mantiuk&Azimi 2021 (✅ vedi §3) | minimo | HDR via PU21; no tempo | Correla male col percettivo |
| SSIM / MS-SSIM | Wang et al. 2004 / 2003 (❓) | basso, GPU-friendly | no | Con PU21 per HDR |
| VMAF | Li et al., Netflix 2016; https://github.com/Netflix/vmaf (🟡) | medio (CPU/CUDA; non su WebGPU) | SDR; modello 4K disponibile | Sensibile a sharpening/ pre-processing |
| VMAF NEG | ✅ https://github.com/Netflix/vmaf (modalità No Enhancement Gain, aggiunta luglio 2020; nome file modello `vmaf_v0.6.1neg.json` non riletto); ✅ https://arxiv.org/abs/2107.04510 (Siniukov et al. 2021) | = VMAF | idem | Limita il "enhancement gain" |
| SSIMULACRA 2 | 🟡 Sneyers, Cloudinary, https://github.com/cloudinary/ssimulacra2 (sviluppato lug–ott 2022, aggiornato apr 2023; BSD-3; 100 = identico, 90 ≈ differenza impercettibile; nessun paper peer-reviewed trovato, solo contributo Cloudinary a ISO/IEC ICQ/AIC-3) | medio | solo immagini | Pensata per immagini fisse |
| Butteraugli | Alakuijala et al., Google (❓) | alto | solo immagini | Idem |
| PSNR-HVS-M | Ponomarenko 2007 (❓) | basso-medio (DCT 8x8) | no | Include masking |
| FUNQUE / FUNQUE+ | ✅ Venkataramanan, Stejerean, Katsavounidis, Bovik, "One Transform To Compute Them All: Efficient Fusion-Based Full-Reference Video Quality Assessment", arXiv 2304.03412 (apr 2023, v2 nov 2023; rivista non confermata; autori corretti: Stejerean, non "Stejerasu", e c'è Katsavounidis). Abstract: +4.2%–5.3% accuratezza e 3.8×–11× efficienza computazionale rispetto a VMAF | basso (1 trasformata wavelet) | no (SDR) | Candidato GPU |
| ColorVideoVDP | ✅ Mantiuk, Hanji, Ashraf, Asano, Chapiro, SIGGRAPH 2024 (ACM TOG), https://arxiv.org/abs/2401.11485 "ColorVideoVDP: A visual difference predictor for image, video and display distortions" (dataset XR-DAVID, 336 video); codice https://github.com/gfxdisp/ColorVideoVDP | alto (pyramid + canali temporali, PyTorch) | **sì**: HDR assoluta, tempo, colore; scala JOD | Non modella saliency/glare |
| CAMBI (banding) | ✅ Tandon, Afonso, Sole, Krasula, "CAMBI: Contrast-aware Multiscale Banding Index", PCS 2021, arXiv 2102.00079; open-source in libvmaf (ott 2021, ✅ repo VMAF) | basso | SDR | Specifico per banding |

**Cosa serve davvero, e cosa non serve.** Il problema chiave: le metriche full-reference confrontano con la sorgente e penalizzano qualsiasi pre-filtro, anche invisibile (PSNR/SSIM calano quando si rimuove rumore reale). Inoltre VMAF (default) può essere **ingannato** da pre-processing (sharpening, equalizzazione istogramma) che aumenta il punteggio senza migliorare la qualità: Netflix ha introdotto VMAF NEG per evitarlo (✅ https://arxiv.org/abs/2107.04510, Siniukov et al.: il pre-processing ottimizzato alza VMAF fino a +218.8% e anche VMAF NEG fino a +23.6%, mentre nei test soggettivi la qualità per lo più cala o resta uguale: neanche NEG è a prova di "hack"). Nel nostro caso il rischio è inverso: smoothing riduce VIF/ADM→ penalità; ma uno smoothing "buono" non farà alzare il punteggio, quindi non c'è rischio di gonfiare; il rischio è **sottovalutare** i guadagni e scegliere filtri troppo timidi.

**Come la letteratura gestisce il problema (e cosa proponiamo).**
1. Misurare sempre contro la **sorgente non filtrata** (Netflix NEG per codec; per pre-processing nel documento di Netflix si consiglia NEG per comparare codec e VMAF default se si valuta anche l'enhancement).
2. Dividere l'errore in due: (a) visibilità del pre-filtro: metrica JND-aware (ColorVideoVDP o HDR-VDP) fra sorgente e uscita del pre-filtro, vincolo "JOD ≥ soglia" (es. ≥9.5–9.8, ❓ soglia da calibrare con test A/B); (b) distorsione dell'encoder rispetto all'uscita del pre-filtro con SSIM/FUNQUE-like (veloce, GPU). Attenzione: (b) usa come riferimento il frame filtrato, quindi è lecito solo perché (a) garantisce che il filtrato è indistinguibile dalla sorgente.
3. Validare offline con test soggettivo: protocollo ISO/IEC 29170-2 (AIC, "visually lossless", 2AFC con flicker) o ITU-R BT.500/BT.2095 (❓), su campione di clip e con più osservatori.
4. Usare più metriche e guardare la **concordanza**; non ottimizzare una sola metrica (Goodhart).

**Cosa ha senso dove.**
- *Guida in-loop sul telefono (GPU, per scena):* SSIM/MS-SSIM su luma in dominio PU21/PQ (un pass di box/gauss filter, banale in WGSL) o FUNQUE+ se implementabile (richiede wavelet, fattibile ma lavoro). Calcolo su sottocampione temporale/spaziale. Affiancare CAMBI-lite (contatore di contorni in zone piatte) per il banding.
- *Validazione offline (desktop/Python):* VMAF NEG e VMAF in HDR (con conversione a PQ, modello adatto ❓), ColorVideoVDP per HDR+tempo, test soggettivo.
- ColorVideoVDP in-loop sul telefono: troppo costoso in tempo reale (❓); usare solo su un piccolo set di frame/crop dopo ogni scena, o tenerlo offline per calibrare i pesi di SSIM/PU21 (calibrazione: regressione del punteggio in-loop su JOD).

---

## 9. Rischi noti

**Banding in zone piatte 10-bit/HLG.**
- Causa: denoise/smoothing rimuove il dithering naturale del sensore, che nascondeva i gradini di quantizzazione; l'encoder poi quantizza ancora di più. HLG ha poca risoluzione nei cieli/ombre scure e i display HDR amplificano.
- Metrica: CAMBI (Netflix, ✅ vedi §8) come guardrail.
- Mitigazioni: (a) denoise adattivo con peso ridotto nelle zone molto piatte (varianza locale bassa) e a luminanze con alta visibilità di bande; (b) **dithering** (blue-noise, ampiezza ≈0.5–1 LSB in dominio PU21) dopo il filtro, in 10 bit prima dell'encoder, per rompere i gradini (costa bit: ampiezza minima); (c) lavorare in float16 e quantizzare solo all'uscita; (d) non filtrare con kernel che appiattiscono rampe.
- ❓ da testare su cieli al tramonto, pareti, nebbia.

**"Plastic look" da denoise.**
- Causa: rimozione di micro-texture (pelle, tessuti, erba) insieme al rumore; il mascheramento da texture per il JND (§3) la tratta come mascheramento, ma il filtro di media la cancella.
- Mitigazioni: denoise temporale (rispetta texture statica, rimuove solo il rumore incorrelato) invece di spaziale; guided/bilateral con edge-stopping; frazione di blend con originale (0.2–0.4); filtro solo su luma ad alta frequenza di piccola ampiezza (core-thresholding di wavelet/laplaciano: sotto soglia JND si attenua, sopra si lascia).
- Validazione soggettiva con clip di volti ravvicinati.

**Flicker temporale del filtro.**
- Cause: decisioni binarie per blocco (match/no match), stima di moto instabile, soglie fisse che oscillano al limite, cambio di forza del filtro tra GOP/segmenti, rumore diverso per frame.
- Mitigazioni: soglie con isteresi; pesi continui (mai commutazione); smoothing temporale delle mappe (JND, forza, ROI) con EMA; stesso parametro per tutto il GOP; nessuna riseed/rumore tempo-variante nel dithering se non necessario (usare blue-noise statico con rotazione leggera ❓); controllo su metrica temporale (differenza media fra frame consecutivi filtrati vs sorgente).
- **Pumping legato ai keyframe:** gli I-frame hanno più qualità del P/B vicino; a bitrate basso è visibile come pulsazione. Se si forzano keyframe sulle scene-cut va bene; evitare keyframe a intervalli corti.

---

## Ranking per rapporto guadagno / rischio / costo GPU

Valutazione soggettiva dell'autore, da confermare con misure sul nostro encoder (❓ tutte).

| # | Tecnica | Guadagno atteso (❓) | Rischio artefatti | Costo GPU | Note |
|---|---|---|---|---|---|
| 1 | Ricerca bitrate per scena (convex hull / pendenza uguale) + keyframe su scene-cut | 10–30% | basso | quasi nullo (metrica GPU leggera) | Guadagno maggiore a parità di rischio; non tocca i pixel |
| 2 | Denoise temporale compensato (MCTF/ricorsivo) | 5–15% (20–40% su low-light) | medio (ghosting, plastic) | medio | Il più ripagante sul rumore sensore |
| 3 | Pre-filtro JND pixel-domain in dominio PU21/HLG | 5–15% | medio (banding, calibrazione) | basso | Dà il "tetto" di sicurezza per i filtri 2, 5 |
| 4 | Dithering/guardia banding (CAMBI-lite) | 0% (protezione) | riduce rischio | basso | Obbligatorio con 2–3 |
| 5 | Mascheramento temporale/da moto (peso dal flusso) | 2–8% | medio-alto (volti in movimento) | basso se il flusso c'è già | Solo come modulatore conservativo |
| 6 | ROI differenziale (volti) | 5–15% sulla scena | medio (aloni, effetto ritratto) | basso + detector | Opzionale; per contenuti con persone |
| 7 | GOP lungo / keyframe adattivi | 3–8% | basso | nullo | Verificare comportamento rate-control HW |
| 8 | Sintesi grana (HEVC SEI/AV1) | alto in teoria | non applicabile | — | Scartare (decoder Apple, codec fissato) |

## Proposta di pipeline (ordine dei filtri)

Per frame, tutto su GPU in float16, ordine:

1. **Decodifica input HLG 10-bit** → texture float16 (YCbCr o RGB lineare-HLG), nessuna perdita.
2. **Scene-cut detection** (differenza istogramma/SAD su luma 1/8, con isteresi) → decisione keyframe e reset della storia temporale.
3. **Stima di moto** (block matching gerarchico su luma 1/4→1/2, 16x16/8x8, ±8–16 px) + mappa di affidabilità; usata per 4, 5, 6.
4. **Denoise temporale compensato** (2–4 frame, pesi per errore di blocco; ricorsivo se non c'è lookahead). Più forte in luma bassa e in aree a moto piccolo.
5. **Mappa JND** (HLG→PU21 via LUT; luminanza + texture con NAMM; modulata da velocità se moto non seguibile; EMA temporale). Cap per sicurezza (0.5–0.7·JND).
6. **Smoothing spaziale vincolato** (guided/bilateral) con modifica limitata a ±JND; blend più forte fuori ROI (se attivo) con maschera sfumata.
7. **Guardia banding**: riduzione del filtro in zone piatte, poi dithering blue-noise a ampiezza minima in dominio PU21; quantizzazione a 10 bit solo qui.
8. **Encoder VT** (WebCodecs) con bitrate per segmento dal loop chiuso e keyframe forzati sulle scene-cut.
9. **Loop chiuso per scena**: dopo l'encode di prova (3 bitrate), metrica in-loop (SSIM/MS-SSIM in PU21 + CAMBI-lite) su sottocampione + vincolo di visibilità del pre-filtro (JND-metric); scelta bitrate a pendenza uguale; validazione offline con VMAF NEG, ColorVideoVDP e test soggettivo AIC (ISO/IEC 29170-2).

Prima iterazione realistica: passi 1–4 + 7 + 9 (solo SSIM/CAMBI), poi aggiungere 5–6.

---

## Verifica fonti (2026-11-18)

Letti solo abstract/metadati (non i paper interi) salvo dove indicato. Netflix Tech Blog, IEEE Xplore, HAL e Amazon arXiv-link non accessibili o errati.

| Fonte | Stato | Nota |
|---|---|---|
| Chou & Li 1995, TCSVT 5(6):467–476 | ✅ abstract | Titolo/anno/volume corretti; introduce PSPNR; nessun numero di bitrate; formula "max" non confermata |
| Yang et al. 2005, TCSVT 15(6):742–752 | corretto ✅ | Autori: Yang, Lin, Lu, Ong, Yao. +0.505 dB PSNR su MPEG-2 TM5 (20 sequenze); "10–30%" non confermato; C≈0.3 non confermato |
| Vanam & Reznik, PCS 2013, pp. 426–429 | ✅ titolo | Titolo esatto; nessuna cifra letta; "10–30%" non confermato |
| JND-guided pre-filtering HEVC UHDTV (HAL hal-03565787) | 🟡 snippet | "fino al 23%" soggettivo, non BD-rate; pagina bloccata; autori non letti |
| JND pre-filter in generale con BD-rate | non trovato | Letteratura per lo più soggettiva; arXiv 2510.10648: −4.84% BD-BR VMAF (neurale, all-intra, snippet) |
| MCTF in VTM (Wennersten JVET-O0549; Ericsson TCSVT/IEEE 9937263) | 🟡 / non confermato | Origine JVET-O0549 da snippet; nessun BD-rate VTM letto |
| Xie et al., EMCTF per VVenC, TCSVT 34(11) 2024 | ✅ abstract | −0.85/−0.91/−0.85/−0.82% (faster/fast/medium/slow); autori e rivista aggiunti |
| Amazon EA-MCTF (Vanam & Sethuraman, DCC 2023) | corretto ✅ | URL arXiv 2407.12465 errato (è un paper su film grain VVC). Cifre −12.4% medio / −50.6% picco VMAF BD-rate su 10 clip x265; HM-MCTF −1.9%; overhead +17% vs +784% |
| Netflix Dynamic Optimizer (blog 2018) | non trovato | Blog 403. Secondarie: 28.04/37.61/33.51% (x264/VP9/x265, VMAF) e "fino al 19%": non confermati |
| Netflix per-title ~20%, GOP lungo 3–8% | non confermato | Nessuna fonte primaria letta |
| PU21 (Mantiuk & Azimi, PCS 2021) | ✅ abstract (PDF) | Range "0.005–10000" non confermato; abstract: fittato fino a 10 000 cd/m², include glare; migliora PSNR/VSI/FSIM/SSIM/MS-SSIM su UPIQ |
| ColorVideoVDP | ✅ | Autori e venue confermati (SIGGRAPH 2024); XR-DAVID 336 video |
| VMAF NEG / "Hacking VMAF and VMAF NEG" | ✅ | NEG da luglio 2020; hacking: VMAF fino a +218.8%, NEG fino a +23.6% |
| FUNQUE | corretto ✅ | Autori: + Katsavounidis, Stejerean (non "Stejerasu"); +4.2–5.3% accuratezza, 3.8–11× più veloce; rivista TIP non confermata |
| CAMBI (Tandon et al., PCS 2021) | ✅ | Autori: Tandon, Afonso, Sole, Krasula; arXiv 2102.00079; in libvmaf da ott 2021 |
| SSIMULACRA 2 | 🟡 | Repo cloudinary/ssimulacra2; nessun paper trovato |
