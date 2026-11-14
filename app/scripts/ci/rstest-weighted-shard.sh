#!/usr/bin/env bash
# Run one duration-weighted shard of an Rstest project from the current directory (app/ or a package directory).
#
# Usage: bash scripts/ci/rstest-weighted-shard.sh <index>/<count> <project> [rstest run options ...]
#
# Rstest's own --shard cuts the alphabetically sorted file list into contiguous slices, so the parts of one split
# giant file (<name>-a.test.ts, <name>-b.test.ts, ...) land in the same shard and one heavy family decides that
# shard's length. This lists the project's files with `rstest list --filesOnly`, weighs each file by the longest
# matching file-name prefix of the "test-weights" map in scripts/ci-matrices.json (measured seconds of the whole
# family, shared equally by the family's files) or CI_DEFAULT_TEST_SECONDS, and deals the files heaviest first to
# the lightest shard. Every shard computes the same deal from the same list, so together the shards run every file
# exactly once. An empty shard passes; a failed listing fails.
set -euo pipefail

shard="${1:?the shard as <index>/<count> is required}"
project="${2:?the Rstest project is required}"
shift 2
if ! [[ "$shard" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || ((BASH_REMATCH[1] > BASH_REMATCH[2])); then
  echo "The shard must be <index>/<count> with 1 <= index <= count, not $shard." >&2
  exit 2
fi
index="${BASH_REMATCH[1]}"
count="${BASH_REMATCH[2]}"
script_directory="$(cd "$(dirname "$0")" && pwd)"
weights="$(jq -c '."test-weights" // {}' "$script_directory/../ci-matrices.json")"
listing="$(mktemp)"
trap 'rm -f "$listing"' EXIT

pnpm exec rstest list --project "$project" --filesOnly --json "$listing" >/dev/null

# A failed listing or deal fails here (set -e on the assignment), never as an empty, passing shard.
total="$(jq -r '(if type == "array" then . else .items end) | length' "$listing")"
deal="$(
  jq -r --argjson weights "$weights" --argjson count "$count" --argjson index "$index" \
    --argjson fallback "${CI_DEFAULT_TEST_SECONDS:-20}" -f "$script_directory/rstest-weighted-shard.jq" "$listing"
)"
if [ "$total" -eq 0 ]; then
  echo "Rstest lists no files for project $project here." >&2
  exit 1
fi
files=()
while IFS= read -r file; do
  [ -n "$file" ] && files+=("$file")
done <<<"$deal"

echo "Rstest project $project, weighted shard $index/$count: ${#files[@]} files"
if [ "${#files[@]}" -eq 0 ]; then
  exit 0
fi
printf '  %s\n' "${files[@]}"
exec pnpm exec rstest --project "$project" "$@" "${files[@]}"
