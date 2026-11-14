#!/usr/bin/env bash
# Wait, with a hard deadline, until every build shard job of this workflow run has reached a state, so a job that
# started right after planning can prepare its services first and need the build outputs only afterwards.
#
# Usage: bash scripts/wait-for-build-shards.sh <started|finished> <shard job name prefix> <shard count>
#   started  - every shard has a runner (in progress or done). The build-lease job waits for this, so jobs that later
#              wait for `finished` can never hold every runner while a shard is still queued.
#   finished - every shard succeeded, so its uploaded outputs can be downloaded.
# Fails at once, naming the shard, when a shard ends without success; fails when the deadline passes.
# Needs: GH_TOKEN (actions: read), GITHUB_REPOSITORY and GITHUB_RUN_ID, as in every Actions job.
# WAIT_FOR_BUILD_SHARDS_INTERVAL (seconds, default 15) and WAIT_FOR_BUILD_SHARDS_TIMEOUT (seconds, default 1500).
set -euo pipefail

mode="${1:?the state to wait for (started or finished) is required}"
prefix="${2:?the job name prefix of the build shards is required}"
count="${3:?the shard count is required}"
interval="${WAIT_FOR_BUILD_SHARDS_INTERVAL:-15}"
timeout="${WAIT_FOR_BUILD_SHARDS_TIMEOUT:-1500}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
case "$mode" in
  started | finished) ;;
  *)
    echo "The state to wait for must be started or finished, not $mode." >&2
    exit 2
    ;;
esac
tab="$(printf '\t')"

# One `<status>\t<conclusion>\t<name>` line per shard job of the newest attempt (filter=latest keeps re-run jobs).
filter='.jobs[] | select(.name | startswith(env.PREFIX)) | [.status, (.conclusion // "none"), .name] | @tsv'
url="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?filter=latest&per_page=100"
deadline=$((SECONDS + timeout))

while :; do
  jobs="$(PREFIX="$prefix" gh api --paginate "$url" --jq "$filter")"
  ended="$(printf '%s\n' "$jobs" | awk -F "$tab" '$2 != "none" && $2 != "success" { print $3 " (" $2 ")" }')"
  if [ -n "$ended" ]; then
    echo "::error title=Build shard did not succeed::$(printf '%s' "$ended" | tr '\n' ',')"
    exit 1
  fi
  if [ "$mode" = started ]; then
    reached="$(printf '%s\n' "$jobs" | awk -F "$tab" '$1 == "in_progress" || $1 == "completed"' | grep -c . || true)"
  else
    reached="$(printf '%s\n' "$jobs" | awk -F "$tab" '$2 == "success"' | grep -c . || true)"
  fi
  if [ "$reached" -ge "$count" ]; then
    echo "All $count shards of $prefix have $mode."
    exit 0
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error title=Build shards too slow::Only $reached of $count shards of $prefix had $mode after ${timeout}s."
    exit 1
  fi
  sleep "$interval"
done
