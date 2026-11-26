#!/usr/bin/env bash
# NUL paths throughout: a changed name is literal, never a pathspec or a line to split on whitespace.
set -euo pipefail
export LC_ALL=C GIT_LITERAL_PATHSPECS=1
cd "$(git rev-parse --show-toplevel)"
shard="${1:?lint shard (0, 1, 2, 3) is required}"
if [[ "$shard" == 0 ]]; then
  changed="${2:?changed-path list is required for shard 0}"
  [[ -s "$changed" ]] || { echo 'No changed paths for shard 0.' >&2; exit 1; }
  # Deleted paths have no content to lint. An all-deletion diff is a valid, empty selection.
  xargs -0 git ls-files -z -- <"$changed"
else
  case "$shard" in 1 | 2 | 3) ;; *) echo "Invalid lint shard: $shard" >&2; exit 1 ;; esac
  # The existing gates' three slices, in git ls-files byte order. Shared by stage and gates.
  starts=(app/scripts/ app/verticals/inventory/)
  current=1
  git ls-files -z | while IFS= read -r -d '' file; do
    while ((current < 3)) && [[ ! "$file" < "${starts[current - 1]}" ]]; do
      current=$((current + 1))
    done
    if ((current == shard)); then printf '%s\0' "$file"; fi
  done
fi
