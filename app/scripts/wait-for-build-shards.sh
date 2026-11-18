#!/usr/bin/env bash
# Wait until every other build shard of one target in this workflow run has uploaded its outputs, so
# the shard running this can download every shard's build outputs and prove the whole topology.
# Fails as soon as one of them ends without success, so a failed shard fails its target's proof by
# name.
#
# Usage: bash scripts/wait-for-build-shards.sh <shard job name prefix> <shard count> <this shard's job name>
# Needs: GH_TOKEN (actions: read), GITHUB_REPOSITORY and GITHUB_RUN_ID, as in every Actions job, and
# WAIT_FOR_ARTIFACT_PATTERN: the artifact name, or name prefix ending in `*`, that the caller downloads
# next; the target's shards publish exactly <shard count> artifacts under it.
set -euo pipefail

prefix="${1:?the job name prefix of the build shards of the target is required}"
count="${2:?the shard count of the target is required}"
own="${3:-}"
expected="$count"
[[ -z "$own" ]] || expected="$((count - 1))"
interval="${WAIT_FOR_BUILD_SHARDS_INTERVAL:-5}"
tab="$(printf '\t')"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
artifact_pattern="${WAIT_FOR_ARTIFACT_PATTERN:?the artifact name pattern the caller downloads is required}"

# One `<state>\t<name>` line per other shard of the target. A shard counts as `uploaded` once its own
# upload step succeeded: the job goes on to run its owner tasks, and neither their run time nor their
# result changes the outputs it already published. A shard that ends before its upload fails the wait.
upload_step="Upload the shard's build outputs"
upload_step="${WAIT_FOR_BUILD_UPLOAD_STEP:-$upload_step}"
filter='.jobs[] | select((.name | startswith(env.PREFIX)) and .name != env.OWN)
  | (if any(.steps[]?; .name == env.UPLOAD and .conclusion == "success")
     then "uploaded" else (.conclusion // "pending") end) + "\t" + .name'
url="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?filter=latest&per_page=100"
# A finished upload step does not yet mean the run's artifact list names the artifact: a download that
# lists by pattern a second later can miss it and continue without that shard. The wait ends only once
# the list the download reads names every shard's artifact.
artifacts_filter='[.artifacts[] | select(.expired | not) | .name
  | select(if (env.PATTERN | endswith("*")) then startswith(env.PATTERN | rtrimstr("*")) else . == env.PATTERN end)]
  | unique | .[]'
artifacts_url="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?per_page=100"
# The list names an artifact within seconds of its upload step: in runs 44211156881 and 44217917701 every
# artifact's created_at is its upload step's completed_at. An artifact the list still lacks this long after
# every shard reported its upload has expired or was deleted; a re-run more than a day later, when the kept
# shards' one-day artifacts are gone, meets exactly that. It never comes back, so the wait fails by name.
listing_bound="${WAIT_FOR_ARTIFACT_LISTING_SECONDS:-60}"
uploaded_at=''

while :; do
  # `filter=latest` lists the jobs of the newest attempt, including the ones a re-run kept. An
  # unreadable answer, such as a truncated API response, says nothing about any shard, so the next
  # poll reads the jobs again; the job's own timeout bounds the wait.
  if ! jobs="$(PREFIX="$prefix" OWN="$own" UPLOAD="$upload_step" gh api "$url" --jq "$filter")"; then
    echo "::warning title=Run jobs unreadable::Reading this run's jobs failed; polling again."
    sleep "$interval"
    continue
  fi
  ended="$(printf '%s\n' "$jobs" | grep -v -E "^(success|uploaded|pending)${tab}" | grep -v '^$' || true)"
  if [ -n "$ended" ]; then
    summary="$(printf '%s' "$ended" | tr '\n' ',')"
    echo "::error title=Build shard did not succeed::$summary"
    exit 1
  fi
  succeeded="$(printf '%s\n' "$jobs" | grep -c -E "^(success|uploaded)${tab}" || true)"
  if [ "$succeeded" -eq "$expected" ]; then
    [ -n "$uploaded_at" ] || uploaded_at="$SECONDS"
    if ! names="$(PATTERN="$artifact_pattern" gh api "$artifacts_url" --jq "$artifacts_filter")"; then
      echo "::warning title=Run artifacts unreadable::Reading this run's artifacts failed; polling again."
    else
      listed="$(printf '%s\n' "$names" | grep -c . || true)"
      if [ "$listed" -eq "$count" ]; then
        echo "Every other shard of $prefix uploaded its outputs, and the run lists all $count $artifact_pattern artifacts."
        exit 0
      fi
      if [ "$((SECONDS - uploaded_at))" -ge "$listing_bound" ]; then
        echo "::error title=Build artifacts missing::Every shard of $prefix uploaded its outputs, but ${listing_bound} s later the run lists $listed of $count $artifact_pattern artifacts: $(printf '%s' "$names" | tr '\n' ' '). An expired or deleted artifact never returns; re-run all jobs so every shard uploads again."
        exit 1
      fi
    fi
  fi
  sleep "$interval"
done
