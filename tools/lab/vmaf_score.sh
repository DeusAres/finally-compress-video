#!/usr/bin/env bash
# Usage: vmaf_score.sh <dist> <ref>   (env: VMAF=/path/to/vmaf CLI, THREADS=4)
# Converts both to y4m yuv420p10le (same size) and prints:
#   vmaf_mean,vmaf_p5,neg_mean,neg_p5
# NOTE: VMAF/VMAF-NEG are SDR-trained; on HLG/BT.2020 content they are only INDICATIVE
# (good for relative A/B and rate-quality curves, not absolute quality claims).
set -euo pipefail
DIST=$1; REF=$2
VMAF=${VMAF:-/tmp/claude-0/lab/vmaf-src/libvmaf/build/tools/vmaf}
MODELS=${MODELS:-/tmp/claude-0/lab/vmaf-src/model}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$REF")
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$REF")
for p in ref:"$REF" dist:"$DIST"; do
  ffmpeg -v error -y -i "${p#*:}" -map 0:v:0 -an -vf "scale=$W:$H:flags=bicubic" -strict -1 -pix_fmt yuv420p10le "$T/${p%%:*}.y4m" &
done; wait
"$VMAF" -r "$T/ref.y4m" -d "$T/dist.y4m" --threads "${THREADS:-4}" --quiet \
  --model path=$MODELS/vmaf_v0.6.1.json:name=vmaf --model path=$MODELS/vmaf_v0.6.1neg.json:name=vmaf_neg --json -o "$T/o.json"
python3 -I - "$T/o.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));fr=d["frames"]
def s(k):
    v=sorted(f["metrics"][k] for f in fr); return sum(v)/len(v), v[int(0.05*(len(v)-1))]
a=s("vmaf");b=s("vmaf_neg")
print(f"{a[0]:.2f},{a[1]:.2f},{b[0]:.2f},{b[1]:.2f}")
PY
