#!/usr/bin/env bash
# Wait until every other build shard of one target in this workflow run has uploaded its outputs, so
# the shard running this can download every shard's build outputs and prove the whole topology.
# Fails as soon as one of them ends without success, so a failed shard fails its target's proof by
# name.
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

# One `<state>\t<name>` line per other shard of the target. A shard that is still running counts as
# `uploaded` once its own upload step succeeded, so two proving shards of one target (which keep
# running after their upload) do not wait for each other.
upload_step="Upload the shard's build outputs"
filter='.jobs[] | select((.name | startswith(env.PREFIX)) and .name != env.OWN)
  | (if .conclusion == null and any(.steps[]?; .name == env.UPLOAD and .conclusion == "success")
     then "uploaded" else (.conclusion // "pending") end) + "\t" + .name'
url="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?filter=latest&per_page=100"

while :; do
  # `filter=latest` lists the jobs of the newest attempt, including the ones a re-run kept.
  jobs="$(PREFIX="$prefix" OWN="$own" UPLOAD="$upload_step" gh api "$url" --jq "$filter")"
  ended="$(printf '%s\n' "$jobs" | grep -v -E "^(success|uploaded|pending)${tab}" | grep -v '^$' || true)"
  if [ -n "$ended" ]; then
    summary="$(printf '%s' "$ended" | tr '\n' ',')"
    echo "::error title=Build shard did not succeed::$summary"
    exit 1
  fi
  succeeded="$(printf '%s\n' "$jobs" | grep -c -E "^(success|uploaded)${tab}" || true)"
  if [ "$succeeded" -eq "$((count - 1))" ]; then
    echo "Every other shard of $prefix uploaded its outputs."
    exit 0
  fi
  sleep "$interval"
done
