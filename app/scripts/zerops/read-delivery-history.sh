#!/usr/bin/env bash
# Reads from GitHub what the stage delivery plan starts from (scripts/zerops/delivery-plan-cli.mts plan), as one JSON
# document on stdout. Run history, not Actions caches: a cache entry can be evicted at any time, a run cannot.
#
#   GH_TOKEN=… GITHUB_REPOSITORY=… GITHUB_RUN_NUMBER=… GITHUB_SHA=… read-delivery-history.sh >history.json
#
#   runs         this workflow's latest runs on the stage branch (null when the list cannot be read)
#   mutations    for every earlier run after the newest successful one: whether any attempt reached the step that
#                precedes every stage mutation (`mutated`, null when its jobs cannot be read), and the services its
#                own plan artifact selected (`services`, null when the plan cannot be read or was not needed)
#   comparison   the commits from that successful run's head to this one, from the compare API: whether the base is
#                an ancestor, every changed path (renames as both names), and whether the list may be cut short
#                (null when the comparison cannot be read)
#
# It never fails: every part it cannot read is null, and the planner then deploys every service.
set -uo pipefail
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_NUMBER:?GITHUB_RUN_NUMBER is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"

workflow='.github/workflows/zerops-stage.yml'
branch='demo/sales-crm'
# delivery-plan.mts MUTATION_MARKER: the step right before the first secret sync or push of a run.
marker='Mark the actual deployment attempt'
repository="repos/$GITHUB_REPOSITORY"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/delivery-history.XXXXXX")"
trap 'rm -rf "$work"' EXIT

empty() { jq -n '{runs: null, mutations: [], comparison: null}'; }

if ! runs="$(gh api "$repository/actions/workflows/zerops-stage.yml/runs?branch=demo%2Fsales-crm&per_page=50" \
  --jq '[.workflow_runs[] | {conclusion, head_branch, head_sha, id, path, run_attempt, run_number, status}]')" ||
  ! jq -e 'type == "array"' <<<"$runs" >/dev/null 2>&1; then
  echo 'the run history could not be read; every service deploys' >&2
  empty
  exit 0
fi

# This workflow's earlier runs on the branch, newest first, and the newest one that succeeded.
earlier="$(jq -c --arg branch "$branch" --arg workflow "$workflow" --argjson number "$GITHUB_RUN_NUMBER" \
  '[.[] | select(.head_branch == $branch and .path == $workflow and .run_number < $number)] | sort_by(-.run_number)' \
  <<<"$runs")"
base="$(jq -c 'first(.[] | select(.status == "completed" and .conclusion == "success")) // null' <<<"$earlier")"
if [ "$base" = null ]; then
  jq -n --argjson runs "$runs" '{runs: $runs, mutations: [], comparison: null}'
  exit 0
fi
base_number="$(jq -r '.run_number' <<<"$base")"
base_sha="$(jq -r '.head_sha' <<<"$base")"

# Did any attempt of the run reach the mutation marker? The jobs of every attempt, not only the latest one.
mutated() {
  gh api "$repository/actions/runs/$1/jobs?filter=all&per_page=100" \
    --jq "[.jobs[].steps[]? | select(.name == \"$marker\" and (.conclusion == \"success\" or .status == \"in_progress\"))] | length > 0"
}
# The services of the run's own plan artifact (zerops-delivery-plan, uploaded before its first mutation).
planned_services() {
  local artifact
  artifact="$(gh api "$repository/actions/runs/$1/artifacts?name=zerops-delivery-plan" --jq '.artifacts[0].id // empty')" &&
    [ -n "$artifact" ] &&
    gh api "$repository/actions/artifacts/$artifact/zip" >"$work/plan-$1.zip" &&
    unzip -p "$work/plan-$1.zip" plan.json | jq -ce '.services | if type == "array" then . else error("no services") end'
}

mutations='[]'
for id in $(jq -r --argjson base "$base_number" '.[] | select(.run_number > $base) | .id' <<<"$earlier"); do
  state="$(mutated "$id" 2>/dev/null)" || state=null
  case "$state" in true | false) ;; *) state=null ;; esac
  services=null
  if [ "$state" = true ]; then
    services="$(planned_services "$id" 2>/dev/null)" || services=null
    [ -n "$services" ] || services=null
  fi
  mutations="$(jq -c --argjson id "$id" --argjson mutated "$state" --argjson services "$services" \
    '. + [{runId: $id, mutated: $mutated, services: $services}]' <<<"$mutations")"
done

# The changed files are listed on the first page for the whole comparison; per_page=1 keeps the commit list short.
# GitHub lists at most 300 files, so a list of 300 or more may be cut short.
comparison="$(gh api "$repository/compare/$base_sha...$GITHUB_SHA?per_page=1" \
  --jq "{base: \"$base_sha\", ancestor: (.status == \"ahead\" or .status == \"identical\"),
         changedPaths: ([.files[]? | .filename, (.previous_filename // empty)] | unique),
         truncated: ((.files | length) >= 300 or (has(\"files\") | not))}" 2>/dev/null)" || comparison=null
jq -e 'type == "object"' <<<"$comparison" >/dev/null 2>&1 || comparison=null

jq -n --argjson runs "$runs" --argjson mutations "$mutations" --argjson comparison "$comparison" \
  '{runs: $runs, mutations: $mutations, comparison: $comparison}'
