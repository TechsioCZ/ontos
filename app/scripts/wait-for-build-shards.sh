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
# WAIT_FOR_BUILD_SHARDS_INTERVAL (seconds, default 20: about 20 waiting rows share one 1,000 requests per hour token,
# and a row waits at most one interval longer) and WAIT_FOR_BUILD_SHARDS_TIMEOUT (seconds, default 1500).
# WAIT_FOR_BUILD_SHARDS_MISSING_TIMEOUT (seconds, unset by default): fail when no job of the prefix exists for that
# long. Only for a caller whose awaited jobs are created together with it (zerops-stage.yml's Verify and its app
# deploy share their `needs`); a gate row waits for shards that are created later and leaves it unset.
# A failed read of the jobs (5xx, 429 or a rate-limit 403, a network error, an incomplete page) is asked again with
# back-off (up to 60 s) inside the same deadline and never counts as an answer; 401, 404 and any other 403 fail at once.
set -euo pipefail

mode="${1:?the state to wait for (started or finished) is required}"
prefix="${2:?the job name prefix of the build shards is required}"
count="${3:?the shard count is required}"
interval="${WAIT_FOR_BUILD_SHARDS_INTERVAL:-20}"
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
# No job of the prefix yet (it is created when its `needs` are done) is an empty list: keep waiting, never an error.
filter='.jobs[] | select(.name | startswith(env.PREFIX)) | [.status, (.conclusion // "none"), .name] | @tsv'
url="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?filter=latest&per_page=100"
deadline=$((SECONDS + timeout))
missing_timeout="${WAIT_FOR_BUILD_SHARDS_MISSING_TIMEOUT:-}"
missing_since=''
backoff="$interval"

# Whether a failed `gh api` read (its standard error) is worth asking again: rate limits, server errors and network
# errors are; authentication, permission and a missing run are not.
transient_read_failure() {
  if grep -qiE 'rate limit|HTTP 429|HTTP 5[0-9][0-9]' <<<"$1"; then return 0; fi
  if grep -qE 'HTTP 4[0-9][0-9]' <<<"$1"; then return 1; fi
  return 0
}

while :; do
  read_error="$(mktemp)"
  if ! jobs="$(PREFIX="$prefix" gh api --paginate "$url" --jq "$filter" 2>"$read_error")"; then
    failure="$(head -c 2000 "$read_error")"
    rm -f "$read_error"
    if ! transient_read_failure "$failure"; then
      echo "::error title=Jobs of this run unreadable::$(printf '%s' "$failure" | tr '\n' ' ')"
      exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "::error title=Build shards too slow::The jobs of this run were unreadable at the deadline: $(printf '%s' "$failure" | tr '\n' ' ')"
      exit 1
    fi
    echo "::warning title=Jobs read failed::asking again in ${backoff}s: $(printf '%s' "$failure" | tr '\n' ' ')"
    sleep "$backoff"
    backoff=$((backoff < 30 ? (backoff < 1 ? 1 : backoff * 2) : 60))
    continue
  fi
  rm -f "$read_error"
  backoff="$interval"
  ended="$(printf '%s\n' "$jobs" | awk -F "$tab" 'NF >= 3 && $2 != "none" && $2 != "success" { print $3 " (" $2 ")" }')"
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
  if [ -n "$missing_timeout" ] && [ -z "$jobs" ]; then
    missing_since="${missing_since:-$SECONDS}"
    if [ $((SECONDS - missing_since)) -ge "$missing_timeout" ]; then
      echo "::error title=No such job::No job of this run is named $prefix… after ${missing_timeout}s; it was not started in this attempt."
      exit 1
    fi
  else
    missing_since=''
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error title=Build shards too slow::Only $reached of $count shards of $prefix had $mode after ${timeout}s."
    exit 1
  fi
  sleep "$interval"
done
