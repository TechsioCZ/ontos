#!/usr/bin/env bash
# Build the delivery units a gates build shard did not keep from the unit output cache (scripts/ci/unit-output-cache.mts),
# BUILD_JOBS at a time. Run from app/ inside the toolchain (mise exec).
#
# BUILD_UNITS: the app ids to build, space-separated; empty means every unit was kept.
# UNIT_POST_BUILD: optional script run with a unit's directory after its build, for the Shell and every released module
# only (topology/application-release-intent.json), before the unit's cache receipt is stamped. It writes into the unit's
# outputs, so unit-output-cache.mts counts it as an input of every unit's identity (--post-build).
# UNIT_SERVED_ENTRY: optional file the post-build step writes into dist, which every served unit's output must hold
# (--served-entry).
#
# This file is the build driver of the gates' unit identity (unitInputs of scripts/ci/unit-inputs.mts): every script it
# names is an input of every unit, and the packages of its `for project in` loop are typechecked before any unit build.
set -euo pipefail

BUILD_JOBS="${BUILD_JOBS:-2}"
read -ra ids <<<"${BUILD_UNITS:-}"
if [ "${#ids[@]}" -eq 0 ]; then
  echo 'Every unit of this shard was kept from the unit output cache.'
  exit 0
fi
for project in packages/shared-contracts packages/shared-design-tokens; do
  pnpm exec ultramodern-create ultramodern typecheck --build "$project/tsconfig.json"
done
logs="$(mktemp -d)"
served="$(node -e '
  const intent = require("./topology/application-release-intent.json");
  for (const { appId } of intent.modules) console.log(appId);
  console.log("shell-super-app");
')"
export logs served UNIT_POST_BUILD="${UNIT_POST_BUILD:-}" UNIT_SERVED_ENTRY="${UNIT_SERVED_ENTRY:-}"
# Each unit runs its own package `build` script, as pnpm -r run build does, from clean outputs, then gets its post-build
# step when served and its cache receipt.
# shellcheck disable=SC2016 # expanded by the bash -c that runs it for each unit
build_unit='
  id="$1"
  unit="verticals/$id"
  [ "$id" != shell-super-app ] || unit=apps/shell-super-app
  log="$logs/$id.log"
  started="$SECONDS"
  if {
    rm -rf -- "$unit/dist" "$unit/.output" &&
      pnpm --filter "./$unit" run build &&
      { [ -z "$UNIT_POST_BUILD" ] || ! grep -qxF "$id" <<<"$served" || node "$UNIT_POST_BUILD" "$unit"; } &&
      node scripts/ci/unit-output-cache.mts stamp --unit "$id" \
        ${UNIT_SERVED_ENTRY:+--served-entry "$UNIT_SERVED_ENTRY"} ${UNIT_POST_BUILD:+--post-build "$UNIT_POST_BUILD"}
  } >"$log" 2>&1; then
    echo "built $unit in $((SECONDS - started))s"
  else
    tail -80 "$log"
    echo "::error title=Unit build failed::$unit"
    exit 1
  fi
'
# The Shell takes every core of the runner: 78 s alone, 167 s beside Privacy in run 44467964945, where its rspack
# compiles took twice as long. So a shard that holds it builds it alone first, then its other units BUILD_JOBS at
# a time.
first=()
rest=()
for id in "${ids[@]}"; do
  if [ "$id" = shell-super-app ]; then first+=("$id"); else rest+=("$id"); fi
done
status=0
{
  { [ "${#first[@]}" -eq 0 ] || printf '%s\n' "${first[@]}" | xargs -P 1 -n 1 bash -c "$build_unit" _; } &&
    { [ "${#rest[@]}" -eq 0 ] || printf '%s\n' "${rest[@]}" | xargs -P "$BUILD_JOBS" -n 1 bash -c "$build_unit" _; }
} || status=$?
for log in "$logs"/*.log; do
  echo "::group::$(basename "$log" .log)"
  cat "$log"
  echo '::endgroup::'
done
[ "$status" -eq 0 ]
