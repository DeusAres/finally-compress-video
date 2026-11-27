#!/usr/bin/env bash
# BD-rate dei pre-filtri SDR 8 bit (f_dn, f_jnd) con x265 + VMAF contro il riferimento SDR NON filtrato (research/21).
# Uso: prefilter_bd.sh <clip.mov> <nome> <cartella_lavoro> [N_frame=240]   → <cartella>/<nome>.csv (var,mbps,kbps,vmaf,vmaf_neg)
# Riferimento: stesso VF di sdr8_score.sh (HLG→hable), 8 bit (RGB24 → yuv420p BT.709 tv); filtri in prefilter_sdr.py; x265 preset fast, uguale per tutti.
set -euo pipefail
SRC=$1; NAME=$2; D=$3; N=${4:-240}; mkdir -p "$D"; HERE=$(cd "$(dirname "$0")" && pwd)
VMAF=${VMAF:-/tmp/claude-0/lab/vmaf-src/libvmaf/build/tools/vmaf}; MODELS=${MODELS:-/tmp/claude-0/lab/vmaf-src/model}
RATES=${RATES:-"2 3.5 5 8"}; PRESET=${PRESET:-fast}
VARS=${VARS:-"base:none dn5:dn:0.5 dn3:dn:0.3 dn7:dn:0.7 jnd:jnd dnjnd:dnjnd:0.5"}
VF="zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0:peak=10,zscale=t=bt709:m=bt709:r=tv,scale=1920:1080,format=rgb24"
FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$SRC" | head -1 | tr -d ,)
RAW="$D/$NAME.rgb"; ffmpeg -v error -y -ss 0.3 -i "$SRC" -map 0:v:0 -an -frames:v "$N" -vf "$VF" -f rawvideo "$RAW"
toy4m() { ffmpeg -v error -y -f rawvideo -pix_fmt rgb24 -s 1920x1080 -r "$FPS" -i "$1" -vf "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p" -strict -1 "$2"; }
toy4m "$RAW" "$D/$NAME.ref.y4m"; OUT="$D/$NAME.csv"; echo "var,mbps,kbps,vmaf,vmaf_neg" > "$OUT"
for V in $VARS; do
  IFS=: read -r VN MODE A <<<"$V"; FRAW="$D/$NAME.$VN.rgb"
  if [ "$MODE" = none ]; then FRAW=$RAW; else python3 -I "$HERE/prefilter_sdr.py" 1920 1080 "$MODE" "${A:-0.5}" < "$RAW" > "$FRAW"; fi
  toy4m "$FRAW" "$D/$NAME.$VN.y4m"
  for R in $RATES; do
    ffmpeg -v error -y -i "$D/$NAME.$VN.y4m" -c:v libx265 -preset "$PRESET" -b:v ${R}M -maxrate ${R}M -bufsize ${R}M -x265-params "log-level=error:pools=4" -tag:v hvc1 "$D/$NAME.$VN.$R.mp4"
    ffmpeg -v error -y -i "$D/$NAME.$VN.$R.mp4" -strict -1 -pix_fmt yuv420p "$D/dist.y4m"
    "$VMAF" -r "$D/$NAME.ref.y4m" -d "$D/dist.y4m" --threads 4 --quiet \
      --model path=$MODELS/vmaf_v0.6.1.json:name=vmaf --model path=$MODELS/vmaf_v0.6.1neg.json:name=vmaf_neg --json -o "$D/o.json"
    python3 -I - "$D/o.json" "$D/$NAME.$VN.$R.mp4" "$VN" "$R" "$N" "$FPS" >> "$OUT" <<'PY'
import json,sys,os
fr=json.load(open(sys.argv[1]))["frames"];m=lambda k:sum(f["metrics"][k] for f in fr)/len(fr)
a,b=sys.argv[5],sys.argv[6];fps=eval(b);dur=int(a)/fps
print(f"{sys.argv[3]},{sys.argv[4]},{os.path.getsize(sys.argv[2])*8/dur/1000:.0f},{m('vmaf'):.3f},{m('vmaf_neg'):.3f}")
PY
    rm -f "$D/dist.y4m"; tail -1 "$OUT" >&2
  done
  rm -f "$D/$NAME.$VN.y4m"; [ "$MODE" = none ] || rm -f "$FRAW"
done
rm -f "$RAW"
