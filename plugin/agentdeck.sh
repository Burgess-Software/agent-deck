#!/usr/bin/env bash
# CodePath wrapper: OpenDeck launches this with the Elgato registration args
# (-port N -pluginUUID X -registerEvent Y -info JSON). OpenDeck's PATH does not
# include nvm, so locate a usable JS runtime ourselves.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="$HOME/.local/share/agentdeck"
mkdir -p "$LOGDIR/state/claude" "$LOGDIR/state/codex"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && NODE="$candidate"
  done
fi
[ -z "$NODE" ] && NODE="$(command -v bun || true)"
if [ -z "$NODE" ]; then
  echo "agentdeck: no node or bun runtime found" >>"$LOGDIR/plugin.log"
  exit 1
fi

exec "$NODE" "$DIR/bin/plugin.mjs" "$@" >>"$LOGDIR/plugin.log" 2>&1
