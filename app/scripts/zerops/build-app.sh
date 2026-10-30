#!/usr/bin/env sh
# Builds every unit the app host serves (the Shell plus each module of topology/application-release-intent.json)
# for the Node target, BUILD_JOBS at a time, with each unit's own package `build` script. Its `modern deploy` step
# emits .output/index.js, which scripts/zerops/owner-entry.mts turns into the unit's dist/zerops-entry.mjs: the app
# host serves every unit in-process from dist/ inside the installed workspace (.output itself is never deployed).
#
#   ONTOS_PUBLIC_ORIGIN=https://… sh scripts/zerops/build-app.sh [unit ...]
#
# Browser assets are served by the host under /_m/<appId>/, so every unit's public URL is that prefix on the one
# public origin. Logs: $BUILD_LOG_DIR/<unit>.log (default .zerops/build-logs). Run from app/.
set -eu
root="$PWD"

: "${ONTOS_PUBLIC_ORIGIN:?ONTOS_PUBLIC_ORIGIN (the public HTTPS origin of the Shell) is required}"
jobs_limit="${BUILD_JOBS:-3}"
log_dir="${BUILD_LOG_DIR:-.zerops/build-logs}"
mkdir -p "$log_dir"

env_name() { printf 'ULTRAMODERN_PUBLIC_URL_%s' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }
unit_dir() { [ "$1" = shell-super-app ] && printf 'apps/shell-super-app' || printf 'verticals/%s' "$1"; }

if [ "$#" -gt 0 ]; then
  units="$*"
else
  units="shell-super-app $(node -e 'for (const m of require("./topology/application-release-intent.json").modules) console.log(m.appId)')"
fi

export ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP="$ONTOS_PUBLIC_ORIGIN"
for unit in $units; do
  [ "$unit" = shell-super-app ] || export "$(env_name "$unit")=$ONTOS_PUBLIC_ORIGIN/_m/$unit"
done
export ULTRAMODERN_DISABLE_BUILD_TS_CHECKER="${ULTRAMODERN_DISABLE_BUILD_TS_CHECKER:-1}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2560}"

build_unit() {
  unit="$1"
  dir="$(unit_dir "$unit")"
  started="$(date +%s)"
  if (cd "$dir" && pnpm run build && node "$root/scripts/zerops/owner-entry.mts" "$dir") >"$log_dir/$unit.log" 2>&1; then
    echo "built $unit in $(($(date +%s) - started))s"
  else
    tail -40 "$log_dir/$unit.log" >&2
    echo "build failed: $unit (log $log_dir/$unit.log)" >&2
    return 1
  fi
}

started_all="$(date +%s)"
pids=''
for unit in $units; do
  while [ "$(jobs -p | wc -l | tr -d ' ')" -ge "$jobs_limit" ]; do sleep 1; done
  build_unit "$unit" &
  pids="$pids $!"
done
failed=0
for pid in $pids; do
  wait "$pid" || failed=1
done
[ "$failed" -eq 0 ] || { echo "one or more unit builds failed" >&2; exit 1; }
echo "built $(echo "$units" | wc -w | tr -d ' ') units in $(($(date +%s) - started_all))s"
