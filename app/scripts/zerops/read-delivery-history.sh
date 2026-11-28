#!/usr/bin/env bash
# Reads from GitHub what the stage delivery plan starts from (scripts/zerops/delivery-plan-cli.mts plan), as one JSON
# document on stdout. Run history, not Actions caches: a cache entry can be evicted at any time, a run cannot.
#
#   read-delivery-history.sh comparison >comparison.json
#   read-delivery-history.sh complete comparison.json >history.json
# Both use GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_NUMBER and GITHUB_SHA. The first snapshots the verified base
# and compare list. Lint selection and planning snapshot independently, so planning never waits for lint.
# Only the planner needs the later mutation lookups (74 s in run
# 45228629460), so those still overlap its root-importer install.
#
#   runs         this workflow's latest push and dispatch runs on the stage branch in this repository (null when the
#                list cannot be read)
#   mutations    for every earlier run after the newest successful one: whether any attempt reached the step that
#                precedes every stage mutation (`mutated`, null when its jobs cannot be read), and the services its
#                own plan artifact selected (`services`, null when the plan cannot be read or was not needed)
#   comparison   the commits from that successful run's head to this one, from the compare API: whether the base is
#                an ancestor, every changed path (renames as both names), and whether the list may be cut short
#                (null when the comparison cannot be read)
#
# Unreadable GitHub state is null and selects every service/file. A missing or invalid shared snapshot fails closed.
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

mode="${1:?comparison or complete is required}"
case "$mode" in
  comparison)
    # Push and dispatch runs in this repository only: a pull request from a fork can name its branch demo/sales-crm and
    # run its own copy of this workflow, and both push and dispatch need write access here.
    if ! runs="$(gh api "$repository/actions/workflows/zerops-stage.yml/runs?branch=demo%2Fsales-crm&per_page=50" \
      --jq '[.workflow_runs[] | select((.event == "push" or .event == "workflow_dispatch") and .head_repository.id == .repository.id) |
        {conclusion, head_branch, head_sha, id, path, run_attempt, run_number, status}]')" ||
      ! jq -e 'type == "array"' <<<"$runs" >/dev/null 2>&1; then
      echo 'the run history could not be read; every service deploys' >&2
      empty
      exit 0
    fi

    ;;
  complete)
    snapshot="${2:?the shared comparison snapshot is required}"
    jq -e 'has("runs") and has("comparison") and (.runs == null or (.runs | type == "array"))' "$snapshot" >/dev/null || exit 1
    runs="$(jq -c '.runs' "$snapshot")"
    comparison="$(jq -c '.comparison' "$snapshot")"
    if [[ "$runs" == null ]]; then empty; exit 0; fi
    ;;
  *) echo "Unknown history operation: $mode" >&2; exit 1 ;;
esac

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

if [[ "$mode" == comparison ]]; then
  # The changed files are listed on the first page for the whole comparison; per_page=1 keeps the commit list short.
  # GitHub lists at most 300 files, so a list of 300 or more may be cut short.
  # File status enum: GitHub REST OpenAPI components.schemas.diff-entry (also used by compare).
  # https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json
  # previous_filename identifies renames; preserve copy origins too when supplied by GitHub.
  comparison="$(gh api "$repository/compare/$base_sha...$GITHUB_SHA?per_page=1" \
    --jq 'if (.files | type == "array") and
      all(.files[]; type == "object" and (.filename | type == "string" and length > 0) and
        (.status | IN("added", "removed", "modified", "renamed", "copied", "changed", "unchanged")) and
        (if .status == "renamed" then (.previous_filename | type == "string" and length > 0) else true end) and
        (if has("previous_filename") then (.previous_filename | type == "string" and length > 0) else true end))
      then . else error("unreadable comparison files") end'" | {base: \"$base_sha\", ancestor: (.status == \"ahead\" or .status == \"identical\"),
           changedPaths: ([.files[]? | .filename, (.previous_filename // empty)] | unique),
           truncated: ((.files | length) >= 300)}" 2>/dev/null)" || comparison=null
  jq -e 'type == "object"' <<<"$comparison" >/dev/null 2>&1 || comparison=null
  jq -n --argjson runs "$runs" --argjson comparison "$comparison" \
    '{runs: $runs, mutations: [], comparison: $comparison}'
  exit 0
fi

# Did any attempt of the run reach the mutation marker? The jobs of every attempt, not only the latest one.
mutated() {
  local page=1 total='' response count expected suffix='' collected="$work/jobs-$1.jsonl"
  : >"$collected"
  while :; do
    response="$(gh api "$repository/actions/runs/$1/jobs?filter=all&per_page=100$suffix")" || return 1
    # Missing counts, jobs or step lists are not evidence that the marker was absent.
    jq -e '(.total_count | type == "number" and . >= 0 and floor == .) and
      (.jobs | type == "array" and length <= 100) and
      all(.jobs[]; (.id | type == "number") and (.steps | type == "array") and
        all(.steps[]; (.name | type == "string") and (.status | type == "string") and
          (.conclusion == null or (.conclusion | type == "string"))))' <<<"$response" >/dev/null || return 1
    expected="$(jq -r '.total_count' <<<"$response")"
    if [[ -z "$total" ]]; then total="$expected"; fi
    [[ "$total" == "$expected" ]] || return 1
    jq -c '.jobs[]' <<<"$response" >>"$collected"
    count="$(wc -l <"$collected" | tr -d ' ')"
    ((count <= total)) || return 1
    if ((count == total)); then break; fi
    # A short/missing page before total_count, or repeated IDs, cannot prove a negative.
    [[ "$(jq '.jobs | length' <<<"$response")" == 100 ]] || return 1
    page=$((page + 1))
    suffix="&page=$page"
  done
  jq -se --argjson total "$total" '([.[].id] | unique | length) == $total' "$collected" >/dev/null || return 1
  jq -s --arg marker "$marker" '[.[].steps[] |
    select(.name == $marker)] |
    if any(.[]; .conclusion == "success" or .status == "in_progress") then true
    elif any(.[]; .status == "completed" and .conclusion == null) then null
    else false end' "$collected"
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

jq -n --argjson runs "$runs" --argjson mutations "$mutations" --argjson comparison "$comparison" \
  '{runs: $runs, mutations: $mutations, comparison: $comparison}'
