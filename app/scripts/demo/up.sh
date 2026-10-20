#!/usr/bin/env bash
# Sales demo: idempotent local cold start. LOCAL ONLY, never deploys.
#
#   scripts/demo/up.sh                 # containers, migrate, init, demo reset, authz, build, serve
#   DEMO_VERTICALS="party-registry siampark-work" scripts/demo/up.sh
#   DEMO_REBUILD=1 scripts/demo/up.sh  # force native rebuild of every selected app
#   DEMO_RESET=0 scripts/demo/up.sh    # keep database data (SpiceDB grants are still re-written)
#
# Re-running stops the previous demo processes first. Logs: app/.scratch/demo-logs/*.log.
set -euo pipefail
# Demo builds skip the build-time type checker (lint suggestions in tests would fail them); typecheck per package.
export DEMO_DISABLE_TS_CHECKER="${DEMO_DISABLE_TS_CHECKER:-1}"

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP"

DEFAULT_VERTICALS="party-registry siampark-property siampark-occupancy siampark-agreements siampark-work siampark-billing-finance commerce-customer-context workforce tagging sales-pipeline merchandise sales-insights crm siampark-ops"
read -r -a VERTICALS <<<"$(printf '%s' "${DEMO_VERTICALS:-$DEFAULT_VERTICALS}" | tr ',' ' ')"
SCRATCH="$APP/.scratch"
LOG_DIR="$SCRATCH/demo-logs"
PID_DIR="$SCRATCH/demo-pids"
STAMP_DIR="$SCRATCH/demo-build"
STUB_DIR="$SCRATCH/demo-bin"
# Not Siampark's 3031: on the demo machine launchd still owns 3031 for the old Siampark composition service.
COMPOSITION_PORT="${DEMO_COMPOSITION_PORT:-3041}"
SHELL_PORT=3020
DOCKER=(docker --context orbstack)
COMPOSE=("${DOCKER[@]}" compose -f docker-compose.yml -f scripts/demo/compose.demo.yml)
mkdir -p "$LOG_DIR" "$PID_DIR" "$STAMP_DIR" "$STUB_DIR"

say() { printf '\033[1m[demo]\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m[demo] %s\033[0m\n' "$*" >&2
  exit 1
}
# step <log-name> <command...>: run quietly into a log, show its tail on failure.
step() {
  local name="$1"
  shift
  say "$name"
  if ! "$@" >"$LOG_DIR/$name.log" 2>&1; then
    tail -25 "$LOG_DIR/$name.log" >&2
    die "$name failed; full log: $LOG_DIR/$name.log"
  fi
}
pnpm_() { mise exec -- pnpm "$@"; }
WITH_ENV=(mise exec --)
# Exports app/.env into this shell (existing environment wins) so every server sees the same values.
# Parsed here because `source .env` would strip the quotes inside the unquoted JSON (JWK) values.
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

# Native release identity hashes the clean Git HEAD into every build marker, so a commit made while the
# demo runs would make the composition publisher reject the running builds. Builds and the publisher see
# this failing `git` stub instead, which pins every demo build to the unpromotable "workspace" identity.
printf '#!/bin/sh\nexit 1\n' >"$STUB_DIR/git"
chmod +x "$STUB_DIR/git"
NO_GIT=(env "PATH=$STUB_DIR:$PATH")

port_of() { # topology manifest port for a vertical id
  node -e 'const t=require(process.argv[1]);const v=t.verticals.find((x)=>x.id===process.argv[2]);if(!v){process.exit(3)}console.log(new URL(v.moduleFederation.manifestUrl).port)' \
    "$APP/topology/reference-topology.json" "$1"
}
dir_of() { [ "$1" = shell-super-app ] && echo apps/shell-super-app || echo "verticals/$1"; }
contract_of() {
  [ "$1" = shell-super-app ] && echo "apps/shell-super-app/dist/public/.well-known/ontos-shell-runtime.json" ||
    echo "verticals/$1/dist/public/.well-known/ontos-module-manifest.json"
}
wait_http() { # wait_http <url> <seconds> <label>
  local url="$1" deadline=$((SECONDS + $2))
  until curl -fs -o /dev/null --max-time 3 "$url"; do
    [ $SECONDS -lt "$deadline" ] || die "$3 did not answer $url in $2s (see $LOG_DIR)"
    sleep 2
  done
}

for id in "${VERTICALS[@]}"; do
  port_of "$id" >/dev/null || die "Unknown vertical in DEMO_VERTICALS: $id"
done
APPS=(shell-super-app "${VERTICALS[@]}")

# 0. Stop processes from a previous run (containers stay up).
"$APP/scripts/demo/down.sh" >/dev/null 2>&1 || true

# 1. Local environment file. Demo data lives in the isolated siampark_demo database.
if [ ! -f .env ]; then
  say "creating app/.env from .env.example (siampark_demo database, random auth secret)"
  sed -e "s#^BETTER_AUTH_SECRET=.*#BETTER_AUTH_SECRET=$(openssl rand -hex 24)#" \
    -e 's#^POSTGRES_DB=.*#POSTGRES_DB=siampark_demo#' \
    -e 's#@localhost:5433/ontos$#@localhost:5433/siampark_demo#' \
    -e '/^COMMERCE_/d' .env.example >.env
  printf '\nULTRAMODERN_DEPLOYMENT_ENVIRONMENT=development\n' >>.env
  chmod 600 .env
fi
step env-local-ensure pnpm_ env:local:ensure
step spicedb-tls pnpm_ spicedb:tls:local
load_env

# 2. Containers (OrbStack). Isolated project/volume: ontos-demo-db + ontos-demo-spicedb on 5433/50051/8443.
step containers "${COMPOSE[@]}" up -d --wait

# 3. Schema, base context, Siampark baseline, authorization. SpiceDB is in-memory: grants are re-written
#    on every run (demo:reset writes the Siampark account grants).
step db-migrate pnpm_ db:migrate
step local-initialize pnpm_ local:initialize
if [ "${DEMO_RESET:-1}" != 0 ]; then
  step demo-reset pnpm_ demo:reset
  # Sales-demo owners seed after the Siampark baseline; the bot API key is issued later (needs the shell).
  step demo-reset-sales pnpm_ demo:reset:sales
  # E-shop company (Kavárna Doma, LE …023): merges the seed, keeps live demo orders (use --reset to wipe).
  step demo-seed-eshop pnpm_ demo:seed:eshop
fi
# Verifiers of owners whose sales seed is still a placeholder report a missing seeded aggregate; that must
# not block the demo. DEMO_STRICT_VERIFY=1 makes the verification fatal again.
if [ "${DEMO_STRICT_VERIFY:-0}" = 1 ]; then
  step db-verify pnpm_ db:verify
else
  say db-verify
  pnpm_ db:verify >"$LOG_DIR/db-verify.log" 2>&1 ||
    say "WARN db:verify failed (placeholder seeds?): $(grep -E "failed|must" "$LOG_DIR/db-verify.log" | tail -2 | tr "\n" " ")"
fi
# `pnpm authorization:provision-current-actions` always fails in development: it records no assertions for
# explicit Actions (every apply-command is explicit). The demo wrapper derives them for demo@test.com.
step authorization-provision "${WITH_ENV[@]}" node scripts/demo/provision-actions.mts

# 4. Native development builds, only when missing, stale, or forced.
needs_build() {
  local id="$1" dir stamp
  # DEMO_SKIP_BUILD=1 serves whatever dist/ already holds (builds are done separately, e.g. rebuild-one.sh).
  [ "${DEMO_SKIP_BUILD:-0}" = 1 ] && [ -f "$(contract_of "$id")" ] && return 1
  dir="$(dir_of "$id")"
  stamp="$STAMP_DIR/$id.stamp"
  [ "${DEMO_REBUILD:-0}" = 1 ] && return 0
  [ -f "$(contract_of "$id")" ] && [ -f "$stamp" ] || return 0
  [ -n "$(find "$dir" packages pnpm-lock.yaml -newer "$stamp" -type f \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.dev-public/*' \
    -not -path '*/cloudflare-dist/*' -not -path '*/.output/*' -not -path '*/.modern/*' \
    -not -path '*/tsconfig.tsbuildinfo' -print -quit 2>/dev/null)" ]
}
# The package `build` script minus its trailing `modern deploy` step: deploy emits a promotable release
# envelope, which a "workspace" build cannot produce, and `modern serve` only needs dist/.
build_script() {
  node -e 'const s=require(process.argv[1]).scripts.build;const c=s.replace(/ && modern deploy --skip-build --deploy-target node$/u,"");if(c===s){process.exit(3)}console.log(c)' \
    "$APP/$(dir_of "$1")/package.json"
}
build_pids=()
build_ids=()
for id in "${APPS[@]}"; do
  if needs_build "$id"; then
    script="$(build_script "$id")" || die "unexpected build script shape for $id"
    say "building $id (log: $LOG_DIR/build-$id.log)"
    touch "$STAMP_DIR/$id.building"
    ("${NO_GIT[@]}" "${WITH_ENV[@]}" pnpm --dir "$(dir_of "$id")" exec sh -c "$script" >"$LOG_DIR/build-$id.log" 2>&1 &&
      mv "$STAMP_DIR/$id.building" "$STAMP_DIR/$id.stamp") &
    build_pids+=($!)
    build_ids+=("$id")
  fi
done
failed=()
for i in "${!build_pids[@]}"; do
  wait "${build_pids[$i]}" || failed+=("${build_ids[$i]}")
done
for id in "${failed[@]}"; do
  tail -15 "$LOG_DIR/build-$id.log" >&2
done
[ ${#failed[@]} -eq 0 ] || die "build failed: ${failed[*]} (logs: $LOG_DIR/build-<id>.log)"

# 5. Servers. Each runs in its own process group so down.sh can stop the whole tree.
set -m
start() { # start <name> <command...>
  local name="$1"
  shift
  ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL="http://127.0.0.1:$COMPOSITION_PORT/active" \
    ONTOS_DEMO_VERTICALS="$(IFS=,; echo "${VERTICALS[*]}")" \
    nohup "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null &
  echo $! >"$PID_DIR/$name.pid"
}
assert_free() {
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $1 ($2) is already in use by another process: $(lsof -nP -iTCP:"$1" -sTCP:LISTEN | tail -1)"
  fi
}
assert_free "$SHELL_PORT" shell-super-app
assert_free "$COMPOSITION_PORT" composition
for id in "${VERTICALS[@]}"; do assert_free "$(port_of "$id")" "$id"; done

say "starting shell-super-app on :$SHELL_PORT and ${#VERTICALS[@]} verticals"
start shell-super-app "${WITH_ENV[@]}" pnpm --dir apps/shell-super-app exec modern serve
for id in "${VERTICALS[@]}"; do
  start "$id" "${WITH_ENV[@]}" pnpm --dir "verticals/$id" exec modern serve
done
wait_http "http://127.0.0.1:$SHELL_PORT/.well-known/ontos-shell-runtime.json" 180 shell-super-app
for id in "${VERTICALS[@]}"; do
  wait_http "http://127.0.0.1:$(port_of "$id")/.well-known/ontos-module-manifest.json" 180 "$id"
done

say "publishing the development composition on :$COMPOSITION_PORT"
start composition "${NO_GIT[@]}" "${WITH_ENV[@]}" node scripts/siampark/development-composition.mts \
  --environment development --port "$COMPOSITION_PORT"
wait_http "http://127.0.0.1:$COMPOSITION_PORT/active" 180 composition

say "starting the outbox worker host"
start outbox-worker-host "${WITH_ENV[@]}" node --experimental-strip-types ./scripts/outbox-worker-host.generated.mts
sleep 3
kill -0 "$(cat "$PID_DIR/outbox-worker-host.pid")" 2>/dev/null ||
  say "WARN outbox worker host exited; see $LOG_DIR/outbox-worker-host.log"

curl -fsS -o /dev/null --max-time 10 "http://localhost:$SHELL_PORT/" || say "WARN shell root did not answer 2xx"

# 6. Sales-demo accounts, role grants and the agent-bot API key (needs the running shell; idempotent).
step demo-permissions "${WITH_ENV[@]}" node scripts/demo/reset-permissions.mts
# People administration (Lidé a role): company administrators may run core.identity.manage-demo-account.
step accounts-admin-grants "${WITH_ENV[@]}" node scripts/demo/accounts-admin-grants.mts
cat <<EOF

[demo] UP. Shell: http://localhost:$SHELL_PORT/cs/siampark/work   (composition :$COMPOSITION_PORT)
[demo] Verticals: ${VERTICALS[*]}
[demo] Login: management@siampark.demo / password1234  (also operations@, finance@, external@)
[demo] Sales demo: obchod@ / obchodnik@ / ucetni@ / sklad@demo.ontos, password1234; bot key in app/.env.demo.local
[demo] Logs: $LOG_DIR   Stop: scripts/demo/down.sh [--containers]
EOF
