#!/usr/bin/env bash
# Restart only the demo e-mail dispatcher and make sure both Mailpits (demo :8025, test :8026) run. No data resets, no other servers.
#   scripts/demo/email-dispatcher/restart.sh
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$APP"
LOG_DIR="$APP/.scratch/demo-logs"
PID_DIR="$APP/.scratch/demo-pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

load_env() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [ -z "${!key+set}" ] || continue
    if [[ "$value" =~ ^\"(.*)\"$ ]]; then
      value="${BASH_REMATCH[1]}"
      value="${value//\\n/$'\n'}"
      value="${value//\\\"/\"}"
    elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    export "$key=$value"
  done <"$APP/.env"
  export MISE_ARGV0=
}

load_env
PORT="${EMAIL_DISPATCHER_PORT:-3096}" # after load_env so app/.env can override it

docker --context orbstack compose -f docker-compose.yml -f scripts/demo/compose.demo.yml up -d --wait ontos-mailpit ontos-mailpit-test
if [ -f "$PID_DIR/email-dispatcher.pid" ]; then
  pid="$(cat "$PID_DIR/email-dispatcher.pid")"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  rm -f "$PID_DIR/email-dispatcher.pid"
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "[email] port $PORT is busy" >&2; exit 1; fi
set -m
nohup mise exec -- node scripts/demo/email-dispatcher/main.mts >"$LOG_DIR/email-dispatcher.log" 2>&1 </dev/null &
echo $! >"$PID_DIR/email-dispatcher.pid"
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz"; then echo "[email] dispatcher up on :$PORT (log $LOG_DIR/email-dispatcher.log)"; exit 0; fi
  sleep 1
done
tail -20 "$LOG_DIR/email-dispatcher.log" >&2
exit 1
