#!/usr/bin/env bash
# NUL paths throughout: each tracked name is literal and never split on whitespace.
set -euo pipefail
export LC_ALL=C GIT_LITERAL_PATHSPECS=1
cd "$(git rev-parse --show-toplevel)"
shard="${1:?lint shard (1, 2, 3) is required}"
case "$shard" in 1 | 2 | 3) ;; *) echo "Invalid lint shard: $shard" >&2; exit 1 ;; esac
# The three slices, in git ls-files byte order. Used by the gates workflow.
starts=(app/scripts/ app/verticals/inventory/)
current=1
git ls-files -z | while IFS= read -r -d '' file; do
  while ((current < 3)) && [[ ! "$file" < "${starts[current - 1]}" ]]; do
    current=$((current + 1))
  done
  if ((current == shard)); then printf '%s\0' "$file"; fi
done
