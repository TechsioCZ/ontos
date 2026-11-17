#!/usr/bin/env bash
# One stage build shard's units (zerops-stage.yml, job `build`), run from app/.
#
#   reuse-shard-units.sh reuse <identities-dir> <shard> <unit-cache-dir> <archive>
#   reuse-shard-units.sh pack <archive> <unit>...
#   reuse-shard-units.sh earlier <branch> <this-run-id>            (prints run_id=<id> for $GITHUB_OUTPUT, or nothing)
#   reuse-shard-units.sh take-units <identities-dir> <archives-dir> <dists-dir> <missing-file>
#
# `reuse` takes the shard's units from its restored unit cache only when every one of them is proven unchanged: the
# cached build's recorded identity (.zerops-build-digest, written when it was built) equals the identity this commit
# gives the unit (<identities-dir>/digests.tsv, written by `build-app.sh --digests-only` in the delivery job),
# and the cached build has its entry. Then it lays the builds out as dist/ and packs them as a build would, so the job
# needs no install and builds nothing. Any doubt (no unit list, no identity, a missing or different cached build)
# exits 3: the job installs and builds as before, and build-app.sh proves every kept unit again. The Zerops build
# proves them a third time before it keeps them.
#
# `earlier` names the newest other run of <branch> that still holds unit builds (artifact zerops-units-0), from the
# Actions API (GH_TOKEN with `actions: read`). No such run, or any API failure, prints nothing: the matrix builds.
#
# `take-units` is the delivery job's front path, unit by unit. Every unit of this commit's identity table that the
# archives under <archives-dir> (an earlier run's unit builds, at any depth) hold exactly once, with its entry and the
# recorded identity this commit gives it, is laid out under <dists-dir> as <unit dir>/dist. Every other unit is written
# to <missing-file>, one per line: the Zerops build or the build matrix builds it. No archive, or an unreadable one,
# takes nothing.
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
  # The cache keeps only this shard's units, so the entry saved under the shard's name holds exactly them.
  for cached in "$cache"/*; do
    [ -e "$cached" ] || continue
    case " $units " in *" $(basename "$cached") "*) ;; *) rm -rf -- "$cached" ;; esac
  done
  # shellcheck disable=SC2086 # units is a list of unit ids.
  pack "$archive" $units
  echo "shard $shard: reused $(echo "$units" | wc -w | tr -d ' ') units by identity, nothing built: $units"
}

earlier() {
  local branch="$1" run_id="$2" found
  found="$(BRANCH="$branch" RUN_ID="$run_id" gh api \
    "repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}/actions/artifacts?name=zerops-units-0&per_page=30" \
    --jq '[.artifacts[] | select(.expired == false and .workflow_run.head_branch == env.BRANCH and
      (.workflow_run.id | tostring) != env.RUN_ID)] | sort_by(.created_at) | last | .workflow_run.id // empty' \
    2>/dev/null)" || found=''
  if [[ "$found" =~ ^[0-9]+$ ]]; then
    echo "earlier unit builds: run $found" >&2
    printf 'run_id=%s\n' "$found"
  else
    echo 'no earlier unit builds of this branch' >&2
  fi
}

take_units() {
  local identities="$1" archives="$2" dists="$3" missing="$4" scratch archive index=0 unit expected dir copies source
  local taken=0 total=0
  local -a found=()
  : >"$missing"
  mkdir -p "$dists"
  if [ -d "$archives" ]; then
    mapfile -t found < <(find "$archives" -type f -name units.tar.zst | LC_ALL=C sort)
  fi
  scratch="$(mktemp -d)"
  # shellcheck disable=SC2064 # the scratch path is fixed now.
  trap "rm -rf '$scratch'" RETURN
  # GNU tar (the runner) reads member patterns literally unless told; bsdtar always globs.
  local -a glob=()
  if tar --version 2>/dev/null | grep -q 'GNU tar'; then glob=(--wildcards --wildcards-match-slash); fi
  for archive in "${found[@]}"; do
    mkdir -p "$scratch/$index"
    # Only each unit's recorded identity and entry; an unreadable archive is a doubt like any other.
    if ! tar --extract --zstd --file "$archive" -C "$scratch/$index" "${glob[@]}" \
      '*/dist/.zerops-build-digest' '*/dist/zerops-entry.mjs' 2>/dev/null; then
      echo "earlier unit archive $archive is unreadable; no unit is taken from the earlier builds"
      found=()
      rm -rf "${scratch:?}"/*
      break
    fi
    index=$((index + 1))
  done
  while IFS=$'\t' read -r unit expected _; do
    [ -n "$unit" ] || continue
    total=$((total + 1))
    dir="$(unit_dir "$unit")"
    copies="$(compgen -G "$scratch/*/$dir/dist/.zerops-build-digest" | grep -c . || true)"
    if [ "$copies" -ne 1 ]; then
      echo "$unit: in $copies earlier unit archives, not one; it must build"
      echo "$unit" >>"$missing"
      continue
    fi
    source="$(compgen -G "$scratch/*/$dir/dist/.zerops-build-digest")"
    source="${source#"$scratch"/}"
    source="${source%%/*}"
    if [ "$(cat "$scratch/$source/$dir/dist/.zerops-build-digest")" != "$expected" ] ||
      [ ! -f "$scratch/$source/$dir/dist/zerops-entry.mjs" ]; then
      echo "$unit: its earlier build is for other inputs; it must build"
      echo "$unit" >>"$missing"
      continue
    fi
    rm -rf "${dists:?}/$dir/dist"
    tar --extract --zstd --file "${found[$source]}" -C "$dists" "$dir/dist"
    taken=$((taken + 1))
  done <"$identities/digests.tsv"
  echo "took $taken of $total units from the earlier builds by identity; $((total - taken)) must build: $(tr '\n' ' ' <"$missing")"
}

case "${1:-}" in
  earlier)
    [ "$#" -eq 3 ] || { echo 'usage: reuse-shard-units.sh earlier <branch> <this-run-id>' >&2; exit 2; }
    earlier "$2" "$3"
    ;;
  take-units)
    [ "$#" -eq 5 ] || { echo 'usage: reuse-shard-units.sh take-units <identities-dir> <archives-dir> <dists-dir> <missing-file>' >&2; exit 2; }
    take_units "$2" "$3" "$4" "$5"
    ;;
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
