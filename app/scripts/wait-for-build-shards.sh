#!/usr/bin/env bash
# Wait until every other build shard of one target in this workflow run has succeeded, so the shard
# running this can download every shard's build outputs and prove the whole topology. Fails as soon
# as one of them ends without success, so a failed shard fails its target's proof by name.
#
# Usage: bash scripts/wait-for-build-shards.sh <shard job name prefix> <shard count> <this shard's job name>
# Needs: GH_TOKEN (actions: read), GITHUB_REPOSITORY and GITHUB_RUN_ID, as in every Actions job.
set -euo pipefail

prefix="${1:?the job name prefix of the build shards of the target is required}"
count="${2:?the shard count of the target is required}"
own="${3:?the job name of this shard is required}"
interval="${WAIT_FOR_BUILD_SHARDS_INTERVAL:-5}"
tab="$(printf '\t')"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"

# One `<conclusion>\t<name>` line per other shard of the target; a running shard has no conclusion yet.
filter='.jobs[] | select((.name | startswith(env.PREFIX)) and .name != env.OWN) | "\(.conclusion // "pending")\t\(.name)"'
url="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?filter=latest&per_page=100"

while :; do
  # `filter=latest` lists the jobs of the newest attempt, including the ones a re-run kept.
  jobs="$(PREFIX="$prefix" OWN="$own" gh api "$url" --jq "$filter")"
  ended="$(printf '%s\n' "$jobs" | grep -v -E "^(success|pending)${tab}" | grep -v '^$' || true)"
  if [ -n "$ended" ]; then
    summary="$(printf '%s' "$ended" | tr '\n' ',')"
    echo "::error title=Build shard did not succeed::$summary"
    exit 1
  fi
  succeeded="$(printf '%s\n' "$jobs" | grep -c "^success${tab}" || true)"
  if [ "$succeeded" -eq "$((count - 1))" ]; then
    echo "Every other shard of $prefix succeeded."
    exit 0
  fi
  sleep "$interval"
done
