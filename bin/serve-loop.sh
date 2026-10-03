#!/usr/bin/env bash
# pi-web restart loop: runs the server, and whenever it exits — crash, OOM
# SIGKILL, anything — records why to ~/.cache/pi-web/crash.log and brings it
# back in ~2 seconds. Pages reconnect on their own (persistent action token
# + watched-proc restore are server features).
# Started by bin/pi-web inside the "pi-web" tmux session; "pi-web stop" kills
# the session, loop and all.
set -u

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
LOG="$HOME/.cache/pi-web/crash.log"
PORT="${1:-3141}"
NODE="$(command -v node)"
# Prefer the node that runs pi (same rule as bin/pi-web).
PI_BIN="$(command -v pi 2>/dev/null || true)"
if [ -n "$PI_BIN" ] && [ -x "$(dirname "$PI_BIN")/node" ]; then
  NODE="$(dirname "$PI_BIN")/node"
fi

mkdir -p "$(dirname "$LOG")"
cd "$HERE"

while :; do
  "$NODE" "$HERE/server.mjs" --port "$PORT"
  c=$?
  m="$(awk '/MemAvailable/{printf "%dMB", $2/1024}' /proc/meminfo 2>/dev/null)"
  echo ""
  echo "pi-web exited (code $c), MemAvailable: $m — restarting in 2s... (stop with: pi-web stop)"
  {
    echo "$(date '+%Y-%m-%dT%H:%M:%S') exit=$c MemAvailable=$m"
  } >>"$LOG"
  sleep 2
done
