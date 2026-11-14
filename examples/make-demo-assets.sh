#!/bin/sh
# Erzeugt das Demo-Basisvideo (Bild + Ton, 4 s). libx264 ist in
# Standard-ffmpeg-Builds auf macOS und Linux enthalten.
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")/demo-kampagne" && pwd)
ffmpeg -hide_banner -nostdin -y -loglevel warning \
  -f lavfi -i 'testsrc2=size=1280x720:rate=24' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' \
  -t 4 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
  "$dir/base.mp4"
