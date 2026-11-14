#!/bin/zsh
set -euo pipefail
umask 077
video_kit_env="${VIDEO_KIT_WORKER_ENV:-$HOME/.config/video-kit/worker.env}"
[[ -f "$video_kit_env" && ! -L "$video_kit_env" ]] || { print -u2 'Worker configuration is missing or a symlink'; exit 1; }
[[ "$(/usr/bin/stat -f '%Lp' "$video_kit_env")" == 600 && "$(/usr/bin/stat -f '%u' "$video_kit_env")" == "$(id -u)" ]] || { print -u2 'Worker configuration must be owned by the current user with chmod 600'; exit 1; }
set -a
source "$video_kit_env"
set +a
: "${DATA_DIR:?Missing DATA_DIR}" "${NODE_BIN_DIR:?Missing NODE_BIN_DIR}" "${WORKER_APP_DIR:?Missing WORKER_APP_DIR}"
export PATH="$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$WORKER_APP_DIR"
DATA_DIR="$("$NODE_BIN_DIR/node" --import tsx --input-type=module -e 'import { ensureDataDirectory } from "./src/model.ts"; process.stdout.write(ensureDataDirectory(process.env.DATA_DIR));')"
export DATA_DIR
mkdir -p "$DATA_DIR/logs"
exec /usr/bin/caffeinate -i "$NODE_BIN_DIR/node" --import tsx src/cli.ts worker run >>"$DATA_DIR/logs/worker.log" 2>>"$DATA_DIR/logs/worker-error.log"
