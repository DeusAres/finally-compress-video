#!/usr/bin/env bash
# VMAF degli MP4 di tools/diag/sdr8.html contro un riferimento SDR ricavato dalla sorgente HDR, più il peso a VMAF uguale.
# Uso: sdr8_score.sh <sorgente_HDR.mov> <cartella_mp4> [N_frame=300]
#   env: TONEMAP=hable (mobius|reinhard|clip) PEAK=10 NPL=100 DESAT=0   parametri del riferimento (vedi sotto)
#        BASE=<regex variante di base, default ^b_eetf_>  TARGET_VMAF=<valore; default = VMAF della base al bitrate più vicino a 8 Mbps>
#        VMAF, MODELS, THREADS come tools/lab/vmaf_score.sh
# Riferimento SDR (ffmpeg zscale + tonemap), stessi primi N frame della sorgente, in ordine di presentazione, autorotazione attiva:
#   zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=tv:t=linear:npl=$NPL   HLG → luce lineare (zimg: OOTF display-referred),
#                                                                               1.0 = $NPL nit
#   format=gbrpf32le, zscale=p=bt709                                            BT.2020 → BT.709 in lineare
#   tonemap=$TONEMAP:desat=$DESAT:peak=$PEAK                                    Hable su max(R,G,B), picco 10 × 100 nit = 1000 nit (HLG)
#   zscale=t=bt709:m=bt709:r=tv, format=yuv420p10le                             OETF BT.709, Y'CbCr BT.709 limitato
# La variante b_hable della pagina usa la stessa curva (Hable, picco 1000 nit, nominale 100 nit, max-RGB): il confronto tra
# varianti con tone map diversi (a/b_eetf/c) è quindi sbilanciato a favore di b_hable → per (a)/(b)/(c) conta il PNG a occhio;
# il VMAF serve per i confronti a parità di tone map: filtri contro base, AV1 contro HEVC, bitrate diversi.
# Le uscite 1080p (ds1080_*) sono valutate a 1080p (riferimento ridotto bicubic), come vmaf_score.sh: non confrontabili con il 4K.
# Uscita: CSV (file,variante,Mbps_chiesti,kbps_reali,vmaf,vmaf_p5,vmaf_neg) e tabella kbps/MB al minuto a VMAF = TARGET.
set -euo pipefail
SRC=$1; DIR=$2; N=${3:-300}
VMAF=${VMAF:-/tmp/claude-0/lab/vmaf-src/libvmaf/build/tools/vmaf}
MODELS=${MODELS:-/tmp/claude-0/lab/vmaf-src/model}
TONEMAP=${TONEMAP:-hable}; PEAK=${PEAK:-10}; NPL=${NPL:-100}; DESAT=${DESAT:-0}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
VF="zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=tv:t=linear:npl=$NPL,format=gbrpf32le,zscale=p=bt709,tonemap=$TONEMAP:desat=$DESAT:peak=$PEAK,zscale=t=bt709:m=bt709:r=tv,format=yuv420p10le"
echo "# riferimento: $VF" >&2
ffmpeg -v error -y -i "$SRC" -map 0:v:0 -an -fps_mode passthrough -frames:v "$N" -vf "$VF" -strict -1 "$T/ref.y4m"
ffmpeg -v error -y -i "$T/ref.y4m" -vf "select=eq(n\,$((N / 2))),zscale=m=bt709:r=tv,format=rgb24" -frames:v 1 "$DIR/riferimento_${TONEMAP}_mid.png" || true
RW=$(head -c 200 "$T/ref.y4m" | head -1 | tr ' ' '\n' | sed -n 's/^W//p'); RH=$(head -c 200 "$T/ref.y4m" | head -1 | tr ' ' '\n' | sed -n 's/^H//p')
# dimensioni visualizzate (dopo la rotazione del contenitore)
dims() { local w h r; w=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$1" | head -1 | tr -dc 0-9)
  h=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$1" | head -1 | tr -dc 0-9)
  r=$(ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation -of csv=p=0 "$1" | head -1 | tr -dc 0-9-)
  case "${r:-0}" in 90|-90|270|-270) echo "$h $w";; *) echo "$w $h";; esac; }
CSV="$T/out.csv"; echo "file,variante,mbps_chiesti,kbps_reali,vmaf,vmaf_p5,vmaf_neg" > "$CSV"
for D in "$DIR"/*.mp4; do
  read -r W H < <(dims "$D")
  ND=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$D" | head -1 | tr -dc 0-9)
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$D" | head -1)
  REF="$T/ref.y4m"
  if [ "$W" != "$RW" ] || [ "$H" != "$RH" ]; then REF="$T/ref_${W}x${H}.y4m"; [ -f "$REF" ] || ffmpeg -v error -y -i "$T/ref.y4m" -vf "scale=$W:$H:flags=bicubic" -strict -1 -pix_fmt yuv420p10le "$REF"; fi
  ffmpeg -v error -y -i "$D" -map 0:v:0 -an -fps_mode passthrough -frames:v "$N" -vf "scale=$W:$H:flags=bicubic" -strict -1 -pix_fmt yuv420p10le "$T/dist.y4m"
  FC=$(( ND < N ? ND : N ))
  "$VMAF" -r "$REF" -d "$T/dist.y4m" --threads "${THREADS:-4}" --quiet --frame_cnt "$FC" \
    --model path=$MODELS/vmaf_v0.6.1.json:name=vmaf --model path=$MODELS/vmaf_v0.6.1neg.json:name=vmaf_neg --json -o "$T/o.json"
  B=$(basename "$D" .mp4); KB=$(stat -c %s "$D")
  python3 -I - "$T/o.json" "$B" "$KB" "$DUR" "$ND" >> "$CSV" <<'PY'
import json,sys,re
d=json.load(open(sys.argv[1]));fr=d["frames"];name,size,dur,nd=sys.argv[2],int(sys.argv[3]),float(sys.argv[4] or 0),int(sys.argv[5] or 0)
def s(k):
    v=sorted(f["metrics"][k] for f in fr); return sum(v)/len(v), v[int(0.05*(len(v)-1))]
a=s("vmaf");b=s("vmaf_neg");m=re.match(r"(.+)_([\d.]+)M$",name)
print(f"{name}.mp4,{m.group(1) if m else name},{m.group(2) if m else ''},{size*8/dur/1000 if dur else 0:.0f},{a[0]:.2f},{a[1]:.2f},{b[0]:.2f}")
PY
  echo "$(tail -1 "$CSV")" >&2
done
cat "$CSV"
python3 -I - "$CSV" "${BASE:-^b_eetf_}" "${TARGET_VMAF:-}" <<'PY'
import csv,sys,re,math
rows=list(csv.DictReader(open(sys.argv[1])));base_re=re.compile(sys.argv[2]);tgt=sys.argv[3]
V={}
for r in rows: V.setdefault(r["variante"],[]).append((float(r["kbps_reali"]),float(r["vmaf"])))
base=next((k for k in V if base_re.search(k)),None)
if not tgt:
    if not base: print("\nnessuna variante di base (BASE) e nessun TARGET_VMAF: niente confronto a VMAF uguale"); sys.exit()
    tgt=min(V[base],key=lambda p:abs(p[0]-8000))[1]
tgt=float(tgt)
def at(pts):
    if len(pts)<2: return None
    xs=[math.log(k) for k,_ in pts];ys=[v for _,v in pts];n=len(xs);mx=sum(xs)/n;my=sum(ys)/n
    sxx=sum((x-mx)**2 for x in xs)
    if sxx==0: return None
    b=sum((x-mx)*(y-my) for x,y in zip(xs,ys))/sxx;a=my-b*mx
    return math.exp((tgt-a)/b) if b>0 else None
kb={k:at(sorted(p)) for k,p in V.items()};bk=kb.get(base) if base else None
print(f"\nPeso a VMAF uguale = {tgt:.2f} (fit VMAF = a + b·ln(kbps) per variante; base: {base})")
print(f"{'variante':28} {'kbps@VMAF':>10} {'MB/min':>8} {'vs base':>8}")
for k in sorted(V):
    x=kb[k]
    if x is None: print(f"{k:28} {'n/d (serve >=2 bitrate)':>28}"); continue
    print(f"{k:28} {x:10.0f} {x*60/8/1000:8.1f} {('%+.1f%%'%((x/bk-1)*100)) if bk else '':>8}")
PY
