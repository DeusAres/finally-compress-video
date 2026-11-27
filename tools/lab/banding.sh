#!/usr/bin/env bash
# Usage: banding.sh <src.mov> [secondi=3.5]   -> CSV: variante,kbps,cambi,vmaf,vmaf_neg
# Emula (x265) il percorso 10 bit vs 8 bit (troncamento del decoder) a 8 Mbps e mitigazioni post-troncamento.
# CAMBI: più basso = meno bande (<5 trascurabile, >10 visibile). VMAF indicativo (SDR) su HLG.
# env: BR=8000 (kbps), VMAF, MODELS, TMPDIR, VARIANTS="..." (sottoinsieme)
set -euo pipefail
SRC=$1; DUR=${2:-3.5}; BR=${BR:-8000}
VMAF=${VMAF:-/tmp/claude-0/lab/vmaf-src/libvmaf/build/tools/vmaf}
MODELS=${MODELS:-/tmp/claude-0/lab/vmaf-src/model}
T=$(mktemp -d "${TMPDIR:-/tmp/claude-0/lab/tmp}/band.XXXXXX"); trap 'rm -rf "$T"' EXIT
CT="-colorspace bt2020nc -color_primaries bt2020 -color_trc arib-std-b67"
# sorgente 10 bit (primi DUR s, 1080p)
ffmpeg -v error -y -t "$DUR" -i "$SRC" -map 0:v:0 -an -vf "scale=1920:1080:flags=bicubic,format=yuv420p10le" -strict -1 -pix_fmt yuv420p10le "$T/ref.y4m"
TR="scale=in_range=tv:out_range=tv:flags=bicubic+accurate_rnd:sws_dither=none,format=yuv420p"   # troncamento come il decoder
# varianti: nome|filtro ffmpeg (parte dal 10 bit, uscita 8 o 10 bit)|profondità
V=(
 "m10|null|10"
 "trunc8|$TR|8"
 "dither8_ed|scale=flags=bicubic+accurate_rnd:sws_dither=ed,format=yuv420p|8"
 "dither8_bayer|scale=flags=bicubic+accurate_rnd:sws_dither=bayer:sws_dither=a_dither,format=yuv420p|8"
 "trunc8_deband|$TR,deband=1thr=0.02:2thr=0.02:3thr=0.02:range=16:blur=1,noise=alls=2:allf=t|8"
 "trunc8_deband_n1|$TR,deband=1thr=0.03:2thr=0.03:3thr=0.03:range=24:blur=1,noise=alls=1:allf=t|8"
 "trunc8_noise2|$TR,noise=alls=2:allf=t|8"
 "trunc8_noise4|$TR,noise=alls=4:allf=t|8"
 "trunc8_deband_n3|$TR,deband=1thr=0.03:2thr=0.03:3thr=0.03:range=24:blur=1,noise=alls=3:allf=t|8"
)
echo "variante,kbps,cambi,vmaf,vmaf_neg"
run(){ # nome filtro depth
  local n=$1 f=$2 d=$3 pf=yuv420p; [ "$d" = 10 ] && pf=yuv420p10le
  local prof=main; [ "$d" = 10 ] && prof=main10
  ffmpeg -v error -y -i "$T/ref.y4m" -vf "$f" -pix_fmt $pf -c:v libx265 -preset fast -b:v ${BR}k -maxrate ${BR}k -bufsize $((BR*2))k \
    -profile:v $prof -tag:v hvc1 $CT -x265-params "log-level=error:range=limited:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:info=0" -f hevc "$T/$n.hevc"
  ffmpeg -v error -y -i "$T/$n.hevc" -vf "format=yuv420p10le" -strict -1 -pix_fmt yuv420p10le "$T/$n.y4m"
  local kb; kb=$(python3 -I -c "import os,sys;print(round(os.path.getsize('$T/$n.hevc')*8/$DUR/1000))")
  "$VMAF" -r "$T/ref.y4m" -d "$T/$n.y4m" --threads 4 --quiet --feature cambi --model path=$MODELS/vmaf_v0.6.1.json:name=vmaf \
    --model path=$MODELS/vmaf_v0.6.1neg.json:name=vmaf_neg --json -o "$T/$n.json"
  python3 -I - "$T/$n.json" "$n" "$kb" <<'PY'
import json,sys
fr=json.load(open(sys.argv[1]))["frames"]
m=lambda k:sum(f["metrics"][k] for f in fr)/len(fr)
print(f'{sys.argv[2]},{sys.argv[3]},{m("cambi"):.2f},{m("vmaf"):.2f},{m("vmaf_neg"):.2f}')
PY
}
for v in "${V[@]}"; do IFS='|' read -r n f d <<<"$v"; [ -z "${VARIANTS:-}" ] || [[ " $VARIANTS " == *" $n "* ]] || continue; run "$n" "$f" "$d"; done
# CAMBI della sorgente (riferimento)
"$VMAF" -r "$T/ref.y4m" -d "$T/ref.y4m" --threads 4 --quiet -n --feature cambi --json -o "$T/s.json"
python3 -I -c "import json;fr=json.load(open('$T/s.json'))['frames'];print('sorgente10,-,%.2f,100,100'%(sum(f['metrics']['cambi'] for f in fr)/len(fr)))"
