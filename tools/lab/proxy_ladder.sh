#!/usr/bin/env bash
# Proxy experiments: libx265 (software) as stand-in for VideoToolbox HEVC.
# Usage: proxy_ladder.sh <input.mov> <seconds> <outdir>
# Prints CSV: variant,kbps_target,size_bytes,video_kbps,ssim_all,ssim_y,psnr_y
set -euo pipefail
IN=$1; SEC=$2; OUT=$3; mkdir -p "$OUT"
COLOR="colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc"
REF="$OUT/ref.nut"
# lossless 10-bit reference of the first $SEC seconds (decoded original)
[ -f "$REF" ] || ffmpeg -v error -y -i "$IN" -t "$SEC" -map 0:v:0 -an -pix_fmt yuv420p10le -c:v ffv1 "$REF"
enc() { # name kbps keyint prefilter
  local name=$1 kbps=$2 keyint=$3 vf=$4 f="$OUT/$1_$2.mp4"
  ffmpeg -v error -y -i "$REF" ${vf:+-vf "$vf"} -c:v libx265 -preset faster -profile:v main10 -pix_fmt yuv420p10le \
    -b:v ${kbps}k -x265-params "log-level=error:keyint=$keyint:min-keyint=1:bframes=3:vbv-maxrate=$((kbps*2)):vbv-bufsize=$((kbps*2)):$COLOR" "$f"
  local size=$(stat -c%s "$f")
  local m=$(ffmpeg -v info -i "$f" -i "$REF" -lavfi "[0:v][1:v]ssim;[0:v][1:v]psnr" -f null - 2>&1 | tr '\n' ' ')
  local ssim=$(sed -nE 's/.*SSIM Y:([0-9.]+).*All:([0-9.]+).*/\2,\1/p' <<<"$m")
  local psnr=$(sed -nE 's/.*PSNR y:([0-9.inf]+).*/\1/p' <<<"$m")
  echo "$name,$kbps,$size,$(( size*8/1000/SEC )),$ssim,$psnr"
}
for kb in 4000 6000 8000 10000; do enc shortgop $kb 28 ""; done
for kb in 4000 6000 8000 10000; do enc longgop  $kb 600 ""; done
for kb in 4000 6000 8000; do enc longgop_hqdn3d_light $kb 600 "hqdn3d=1.5:1.5:3:3"; done
for kb in 4000 6000 8000; do enc longgop_atadenoise $kb 600 "atadenoise=0a=0.02:1a=0.03:2a=0.03:0b=0.04:1b=0.06:2b=0.06"; done
