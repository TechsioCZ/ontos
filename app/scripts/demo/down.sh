#!/usr/bin/env bash
# Sales demo: stop the processes started by up.sh. `--containers` also stops the demo containers
# (data volume ontos_demo_postgres_data is kept; SpiceDB is in-memory and loses its grants).
set -uo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_DIR="$APP/.scratch/demo-pids"

if [ -d "$PID_DIR" ]; then
  for file in "$PID_DIR"/*.pid; do
    [ -e "$file" ] || continue
    pid="$(cat "$file")"
    name="$(basename "$file" .pid)"
    if kill -0 "$pid" 2>/dev/null; then
      # up.sh starts each server as its own process group leader; stop the whole tree.
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -KILL -- "-$pid" 2>/dev/null || true
      echo "[demo] stopped $name ($pid)"
    fi
    rm -f "$file"
  done
fi

if [ "${1:-}" = "--containers" ]; then
  docker --context orbstack compose -f "$APP/docker-compose.yml" -f "$APP/scripts/demo/compose.demo.yml" stop
fi
