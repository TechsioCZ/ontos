#!/usr/bin/env bash
# Rebuild and restart selected apps inside a demo started by up.sh, without touching data or other servers.
#
#   scripts/demo/rebuild-one.sh merchandise            # build + restart one vertical
#   scripts/demo/rebuild-one.sh crm siampark-ops        # new verticals are added to the served set
#   scripts/demo/rebuild-one.sh shell-super-app
#
# Builds are serialised through two lock slots so parallel agents do not saturate the machine. The
# composition publisher is restarted whenever the served vertical set changes (or DEMO_RESTART_COMPOSITION=1).
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Demo v2: the live demo is served from a separate runtime worktree that only ever contains COMMITTED code
# from demo/sales-crm, so half-edited files in the shared development tree never break the running demo.
RUNTIME_APP="${DEMO_RUNTIME_APP:-/Volumes/TraceDecayKingston/techsio-demo/ontos-runtime/app}"
if [ "$APP" != "$RUNTIME_APP" ] && [ -d "$RUNTIME_APP" ]; then
  # Serialise the fast-forward so concurrent callers do not race on the runtime index.
  until mkdir "$RUNTIME_APP/.scratch-ff.lock" 2>/dev/null; do sleep 1; done
  trap 'rmdir "$RUNTIME_APP/.scratch-ff.lock" 2>/dev/null' EXIT
  before="$(git -C "$RUNTIME_APP" rev-parse HEAD:app/pnpm-lock.yaml)"
  git -C "$RUNTIME_APP" merge -q --ff-only demo/sales-crm || {
    echo "[rebuild] runtime fast-forward failed" >&2
    exit 1
  }
  if [ "$before" != "$(git -C "$RUNTIME_APP" rev-parse HEAD:app/pnpm-lock.yaml)" ]; then
    echo "[rebuild] lockfile changed; installing in runtime"
    (cd "$RUNTIME_APP" && TMPDIR=/Volumes/TraceDecayKingston/techsio-demo/tmp mise exec -- pnpm install --frozen-lockfile >/dev/null)
  fi
  rmdir "$RUNTIME_APP/.scratch-ff.lock" 2>/dev/null
  trap - EXIT
  echo "[rebuild] runtime at $(git -C "$RUNTIME_APP" log --oneline -1) (only committed code is built)"
  exec "$RUNTIME_APP/scripts/demo/rebuild-one.sh" "$@"
fi
if [ "$#" -eq 1 ] && [ "$1" = akros-storefront ]; then
  exec "$APP/akros-storefront/scripts/demo-restart.sh"
fi
# The customer storefront is a standalone channel app, not a federated vertical.
# Its own helper builds committed code and restarts only :3060; composition stays untouched.
if [ "$#" -eq 1 ] && [ "$1" = eshop-storefront ]; then
  exec "$APP/apps/eshop-storefront/scripts/demo-restart.sh"
fi
cd "$APP"
SCRATCH="$APP/.scratch"
LOG_DIR="$SCRATCH/demo-logs"
PID_DIR="$SCRATCH/demo-pids"
STAMP_DIR="$SCRATCH/demo-build"
STUB_DIR="$SCRATCH/demo-bin"
LOCK_ROOT="$SCRATCH/demo-build-locks"
VERTICALS_FILE="$SCRATCH/demo-verticals"
COMPOSITION_PORT="${DEMO_COMPOSITION_PORT:-3041}"
mkdir -p "$LOG_DIR" "$PID_DIR" "$STAMP_DIR" "$STUB_DIR" "$LOCK_ROOT"
export TMPDIR="${TMPDIR:-/Volumes/TraceDecayKingston/techsio-demo/tmp}"
export DEMO_DISABLE_TS_CHECKER="${DEMO_DISABLE_TS_CHECKER:-1}"
export pnpm_config_verify_deps_before_run=false

say() { printf '\033[1m[rebuild]\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m[rebuild] %s\033[0m\n' "$*" >&2
  exit 1
}
[ $# -gt 0 ] || die "usage: rebuild-one.sh <vertical-id|shell-super-app>... | --composition-only"
COMPOSITION_ONLY=0
if [ "$1" = --composition-only ]; then
  COMPOSITION_ONLY=1
  shift
fi

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
WITH_ENV=(mise exec --)
printf '#!/bin/sh\nexit 1\n' >"$STUB_DIR/git"
chmod +x "$STUB_DIR/git"
NO_GIT=(env "PATH=$STUB_DIR:$PATH")

port_of() {
  node -e 'const t=require(process.argv[1]);const v=t.verticals.find((x)=>x.id===process.argv[2]);if(!v){process.exit(3)}console.log(new URL(v.moduleFederation.manifestUrl).port)' \
    "$APP/topology/reference-topology.json" "$1"
}
dir_of() { [ "$1" = shell-super-app ] && echo apps/shell-super-app || echo "verticals/$1"; }
build_script() {
  node -e 'const s=require(process.argv[1]).scripts.build;const c=s.replace(/ && modern deploy --skip-build --deploy-target node$/u,"");if(c===s){process.exit(3)}console.log(c)' \
    "$APP/$(dir_of "$1")/package.json"
}
wait_http() {
  local url="$1" deadline=$((SECONDS + $2))
  until curl -fs -o /dev/null --max-time 3 "$url"; do
    [ $SECONDS -lt "$deadline" ] || die "$3 did not answer $url in $2s (see $LOG_DIR/$3.log)"
    sleep 2
  done
}
stop_pid() {
  local file="$PID_DIR/$1.pid" pid
  [ -f "$file" ] || return 0
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$file"
}

# Served vertical set: persisted by previous rebuilds, else up.sh's default list.
if [ -f "$VERTICALS_FILE" ]; then
  read -r -a SERVED <"$VERTICALS_FILE"
else
  read -r -a SERVED <<<"$(sed -n 's/^DEFAULT_VERTICALS="\(.*\)"$/\1/p' "$APP/scripts/demo/up.sh")"
fi
changed_set=0
for id in "$@"; do
  [ "$id" = shell-super-app ] && continue
  port_of "$id" >/dev/null || die "unknown vertical $id (add it to topology/reference-topology.json first)"
  if [[ " ${SERVED[*]} " != *" $id "* ]]; then
    SERVED+=("$id")
    changed_set=1
  fi
done

if [ "$COMPOSITION_ONLY" = 1 ]; then set -- ; fi
# Acquire one of two build slots.
slot=""
until [ -n "$slot" ]; do
  for s in 1 2; do
    if mkdir "$LOCK_ROOT/slot-$s" 2>/dev/null; then
      echo $$ >"$LOCK_ROOT/slot-$s/pid"
      slot="$LOCK_ROOT/slot-$s"
      break
    fi
    owner="$(cat "$LOCK_ROOT/slot-$s/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$LOCK_ROOT/slot-$s"; fi
  done
  [ -n "$slot" ] || sleep 5
done
trap 'rm -rf "$slot"' EXIT

for id in "$@"; do
  script="$(build_script "$id")" || die "unexpected build script shape for $id"
  say "building $id (log: $LOG_DIR/build-$id.log)"
  dist="$(dir_of "$id")/dist"
  rm -rf "$dist.prev"
  [ -d "$dist" ] && cp -cR "$dist" "$dist.prev" 2>/dev/null || cp -R "$dist" "$dist.prev" 2>/dev/null || true
  if ! "${NO_GIT[@]}" "${WITH_ENV[@]}" pnpm --dir "$(dir_of "$id")" exec sh -c "$script" >"$LOG_DIR/build-$id.log" 2>&1; then
    grep -E "error|Error" "$LOG_DIR/build-$id.log" | grep -v '^\s*at ' | head -30 >&2
    if [ -d "$dist.prev" ]; then rm -rf "$dist" && mv "$dist.prev" "$dist"; fi
    die "build failed: $id (previous build kept running; full log $LOG_DIR/build-$id.log)"
  fi
  rm -rf "$dist.prev"
  touch "$STAMP_DIR/$id.stamp"
done
rm -rf "$slot"
trap - EXIT

printf '%s\n' "${SERVED[*]}" >"$VERTICALS_FILE"
CSV="$(IFS=,; echo "${SERVED[*]}")"
set -m
start() {
  local name="$1"
  shift
  ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL="http://127.0.0.1:$COMPOSITION_PORT/active" \
    ONTOS_DEMO_VERTICALS="$CSV" \
    nohup "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null &
  echo $! >"$PID_DIR/$name.pid"
}
for id in "$@"; do
  stop_pid "$id"
  if [ "$id" = shell-super-app ]; then
    start shell-super-app "${WITH_ENV[@]}" pnpm --dir apps/shell-super-app exec modern serve
    wait_http "http://127.0.0.1:3020/.well-known/ontos-shell-runtime.json" 180 shell-super-app
  else
    start "$id" "${WITH_ENV[@]}" pnpm --dir "verticals/$id" exec modern serve
    wait_http "http://127.0.0.1:$(port_of "$id")/.well-known/ontos-module-manifest.json" 180 "$id"
  fi
  say "restarted $id"
done

# A rebuilt app gets a new build marker, so the composition must be republished either way.
stop_pid composition
# Demo only: after downtime the previous composition lease has expired and the publisher refuses to drain it.
docker --context orbstack exec ontos-demo-db psql -q -U "${POSTGRES_USER:-ontos_admin}" -d "${POSTGRES_DB:-siampark_demo}" \
  -c "update core.application_composition_authority set valid_until = now() + interval '30 minutes' where valid_until < now() + interval '2 minutes'" \
  >/dev/null 2>&1 || true
# Demo only: party search projections that no worker claimed would block the drain forever (STATUS 02:37, 14:51).
docker --context orbstack exec ontos-demo-db psql -q -U "${POSTGRES_USER:-ontos_admin}" -d "${POSTGRES_DB:-siampark_demo}" \
  -c "update core.outbox_deliveries set status = 'done', updated_at = now() where status = 'pending' and attempts_count = 0 and worker_key like 'party.registry.project-%-to-search' and created_at < now() - interval '2 minutes'" \
  >/dev/null 2>&1 || true
start composition "${NO_GIT[@]}" "${WITH_ENV[@]}" node scripts/siampark/development-composition.mts \
  --environment development --port "$COMPOSITION_PORT"
wait_http "http://127.0.0.1:$COMPOSITION_PORT/active" 180 composition
[ "$changed_set" = 1 ] && say "served verticals now: ${SERVED[*]}"
# Keep the outbox worker host alive so deliveries are processed instead of piling up before the next drain.
if ! kill -0 "$(cat "$PID_DIR/outbox-worker-host.pid" 2>/dev/null)" 2>/dev/null; then
  start outbox-worker-host "${WITH_ENV[@]}" node --experimental-strip-types ./scripts/outbox-worker-host.generated.mts
  say "started the outbox worker host"
fi
say "done: ${*:-composition}"
