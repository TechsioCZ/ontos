#!/usr/bin/env bash
# One stage build shard's units (zerops-stage.yml, job `build`), run from app/.
#
#   reuse-shard-units.sh reuse <identities-dir> <shard> <unit-cache-dir> <archive>
#   reuse-shard-units.sh pack <archive> <unit>...
#
# `reuse` takes the shard's units from its restored unit cache only when every one of them is proven unchanged: the
# cached build's recorded identity (.zerops-build-digest, written when it was built) equals the identity this commit
# gives the unit (<identities-dir>/digests.tsv, written by `build-app.sh --digests-only` in the unit_identities job),
# and the cached build has its entry. Then it lays the builds out as dist/ and packs them as a build would, so the job
# needs no install and builds nothing. Any doubt (no unit list, no identity, a missing or different cached build)
# exits 3: the job installs and builds as before, and build-app.sh proves every kept unit again. The Zerops build
# proves them a third time before it keeps them.
#
# `pack` is the one packing step of both paths: the units' dist/ without source maps, type bundles or precompressed
# copies, which never serve at runtime.
set -euo pipefail

NEEDS_BUILD=3

unit_dir() {
  if [ "$1" = shell-super-app ]; then printf 'apps/shell-super-app'; else printf 'verticals/%s' "$1"; fi
}

pack() {
  local archive="$1" unit
  shift
  local dirs=()
  for unit in "$@"; do dirs+=("$(unit_dir "$unit")/dist"); done
  tar --create --zstd --file "$archive" --exclude='*.map' --exclude='@mf-types*' --exclude='*.br' --exclude='*.gz' \
    "${dirs[@]}"
}

# The single value of a table row's second field, or nothing when the row is missing or repeated.
only_value() {
  awk -F '\t' -v key="$1" '$1 == key { value = $2; count++ } END { if (count == 1) print value }' "$2"
}

reuse() {
  local identities="$1" shard="$2" cache="$3" archive="$4" unit expected recorded dir
  local units
  units="$(only_value "$shard" "$identities/shards.tsv")"
  if [ -z "$units" ]; then
    echo "shard $shard: no unit list for this commit; building"
    return "$NEEDS_BUILD"
  fi
  for unit in $units; do
    expected="$(only_value "$unit" "$identities/digests.tsv")"
    if [ -z "$expected" ]; then
      echo "shard $shard: $unit has no identity for this commit; building"
      return "$NEEDS_BUILD"
    fi
    if [ ! -f "$cache/$unit/zerops-entry.mjs" ]; then
      echo "shard $shard: $unit has no cached build; building"
      return "$NEEDS_BUILD"
    fi
    recorded="$(cat "$cache/$unit/.zerops-build-digest" 2>/dev/null || true)"
    if [ "$recorded" != "$expected" ]; then
      echo "shard $shard: $unit's cached build is for other inputs; building"
      return "$NEEDS_BUILD"
    fi
  done
  for unit in $units; do
    dir="$(unit_dir "$unit")"
    rm -rf "$dir/dist"
    mkdir -p "$dir"
    cp -a "$cache/$unit" "$dir/dist"
  done
  # shellcheck disable=SC2086 # units is a list of unit ids.
  pack "$archive" $units
  echo "shard $shard: reused $(echo "$units" | wc -w | tr -d ' ') units by identity, nothing built: $units"
}

case "${1:-}" in
  reuse)
    [ "$#" -eq 5 ] || { echo 'usage: reuse-shard-units.sh reuse <identities-dir> <shard> <unit-cache-dir> <archive>' >&2; exit 2; }
    reuse "$2" "$3" "$4" "$5"
    ;;
  pack)
    [ "$#" -ge 3 ] || { echo 'usage: reuse-shard-units.sh pack <archive> <unit>...' >&2; exit 2; }
    shift
    pack "$@"
    ;;
  *)
    echo 'usage: reuse-shard-units.sh reuse|pack …' >&2
    exit 2
    ;;
esac
