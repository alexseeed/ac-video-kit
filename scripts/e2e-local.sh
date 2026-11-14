#!/bin/sh
set -eu
umask 077
video_kit_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$video_kit_root"
exec node --import tsx scripts/e2e-local.ts "$@"
