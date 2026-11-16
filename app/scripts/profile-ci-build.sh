#!/usr/bin/env bash
set -euo pipefail

workspace="$(cd "$(dirname "$0")/.." && pwd)"
unit="${PWD#"$workspace"/}"
output="${ONTOS_CI_BUILD_PROFILES:?an absolute artifact directory is required}/$unit"
[[ "$output" == /* ]]
mkdir -p "$output"

# Preserve every command and its order, including contract generation and deploy packaging.
# Refuse lifecycle scripts rather than silently measuring less than `pnpm run build` would run.
jq --exit-status '
  (.scripts.build | type == "string") and
  (.scripts.prebuild == null) and (.scripts.postbuild == null)
' package.json >/dev/null
mapfile -t commands < <(jq --raw-output '.scripts.build | split(" && ")[]' package.json)
export npm_lifecycle_event=build
npm_lifecycle_script="$(jq --raw-output '.scripts.build' package.json)"
export npm_lifecycle_script

snapshot_sources() {
  local destination="$1"
  local roots=()
  for directory in src api shared server; do
    [[ ! -d "$directory" ]] || roots+=("$directory")
  done
  mkdir -p "$(dirname "$destination")"
  if [[ "${#roots[@]}" != 0 ]]; then
    find "${roots[@]}" -type f -print0 | sort -z | xargs -0 -r sha256sum >"$destination.sha256"
    find "${roots[@]}" -type f -printf '%T@ %p\n' | sort >"$destination.mtimes"
  fi
}

phase=0
for command in "${commands[@]}"; do
  phase=$((phase + 1))
  profile_directory=""
  if [[ "$unit" == verticals/catalog || "$unit" == apps/shell-super-app ]]; then
    if [[ "$command" =~ (modern|ultramodern)[[:space:]]build ]]; then
      profile_directory="$output/$phase"
      snapshot_sources "$profile_directory/sources-before"
    fi
  fi
  started="$EPOCHREALTIME"
  status=0
  ONTOS_BUILD_PROFILE_DIR="$profile_directory" \
    /usr/bin/time -v -o "$output/$phase.resources.txt" bash -euc "$command" || status="$?"
  seconds="$(awk -v start="$started" -v end="$EPOCHREALTIME" 'BEGIN { printf "%.3f", end - start }')"
  jq --null-input --arg unit "$unit" --arg command "$command" \
    --argjson seconds "$seconds" --argjson exitCode "$status" \
    --arg profileDirectory "$profile_directory" \
    '{unit: $unit, command: $command, seconds: $seconds, exitCode: $exitCode, profileDirectory: $profileDirectory}' \
    >"$output/$phase.json"
  printf 'BUILD_COMMAND %s\n' "$(jq --compact-output . "$output/$phase.json")"
  if [[ -n "$profile_directory" ]]; then
    snapshot_sources "$profile_directory/sources-after"
  fi
  if [[ "$status" != 0 ]]; then
    exit "$status"
  fi
done
