#!/usr/bin/env bash
# Kavárna Doma storefront in the local sales demo: build and (re)start on :3060. LOCAL ONLY, never deploys.
#
#   apps/eshop-storefront/scripts/demo-restart.sh          # from the shared tree or the runtime worktree
#   STOREFRONT_SKIP_BUILD=1 apps/eshop-storefront/scripts/demo-restart.sh
#
# Like rebuild-one.sh, it serves COMMITTED code from the runtime worktree when that exists. The pid lands in
# .scratch/demo-pids/eshop-storefront.pid, so scripts/demo/down.sh stops it with everything else.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNTIME_APP="${DEMO_RUNTIME_APP:-/Volumes/TraceDecayKingston/techsio-demo/ontos-runtime/app}"
if [ "$APP" != "$RUNTIME_APP" ] && [ -d "$RUNTIME_APP" ] && [ "${STOREFRONT_LOCAL:-0}" != 1 ]; then
  until mkdir "$RUNTIME_APP/.scratch-ff.lock" 2>/dev/null; do sleep 1; done
  trap 'rmdir "$RUNTIME_APP/.scratch-ff.lock" 2>/dev/null' EXIT
  git -C "$RUNTIME_APP" merge -q --ff-only demo/sales-crm || {
    echo "[storefront] runtime fast-forward failed" >&2
    exit 1
  }
  rmdir "$RUNTIME_APP/.scratch-ff.lock" 2>/dev/null
  trap - EXIT
  echo "[storefront] runtime at $(git -C "$RUNTIME_APP" log --oneline -1)"
  exec "$RUNTIME_APP/apps/eshop-storefront/scripts/demo-restart.sh" "$@"
fi

cd "$APP"
export TMPDIR="${TMPDIR:-/Volumes/TraceDecayKingston/techsio-demo/tmp}"
export pnpm_config_verify_deps_before_run=false
PORT="${ESHOP_STOREFRONT_PORT:-3060}"
LOG_DIR="$APP/.scratch/demo-logs"
PID_DIR="$APP/.scratch/demo-pids"
PID_FILE="$PID_DIR/eshop-storefront.pid"
mkdir -p "$LOG_DIR" "$PID_DIR"

if [ ! -x apps/eshop-storefront/node_modules/.bin/rsbuild ]; then
  echo "[storefront] installing dependencies (frozen lockfile)"
  mise exec -- pnpm install --frozen-lockfile >"$LOG_DIR/build-eshop-storefront-install.log" 2>&1
fi
if [ "${STOREFRONT_SKIP_BUILD:-0}" != 1 ] || [ ! -f apps/eshop-storefront/dist/index.html ]; then
  echo "[storefront] building (log: $LOG_DIR/build-eshop-storefront.log)"
  mise exec -- pnpm --dir apps/eshop-storefront build >"$LOG_DIR/build-eshop-storefront.log" 2>&1 || {
    tail -20 "$LOG_DIR/build-eshop-storefront.log" >&2
    exit 1
  }
fi

if [ -f "$PID_FILE" ]; then
  old="$(cat "$PID_FILE")"
  if kill -0 "$old" 2>/dev/null; then
    kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$old" 2>/dev/null || break
      sleep 0.25
    done
  fi
  rm -f "$PID_FILE"
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[storefront] port $PORT is still in use: $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | tail -1)" >&2
  exit 1
fi

set -m
ESHOP_STOREFRONT_PORT="$PORT" nohup mise exec -- node apps/eshop-storefront/server/server.ts \
  >"$LOG_DIR/eshop-storefront.log" 2>&1 </dev/null &
echo $! >"$PID_FILE"
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    echo "[storefront] UP: http://localhost:$PORT  (log: $LOG_DIR/eshop-storefront.log)"
    exit 0
  fi
  sleep 0.5
done
tail -20 "$LOG_DIR/eshop-storefront.log" >&2
echo "[storefront] did not answer on :$PORT" >&2
exit 1
