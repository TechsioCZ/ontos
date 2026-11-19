#!/usr/bin/env bash
# A push to a branch without a merge queue (the demo trunk) may land a commit that a candidate/* dispatch of this same
# workflow already proved. Two subcommands, so the record and its reader share one format:
#
#   record <file>  In a candidate/* dispatch's ci-plan job: what its plan compared with (HEAD_SHA, BASE_REF, BASE_SHA,
#                  PLAN_MODE) as JSON. The workflow publishes the file as this run's ci-comparison artifact.
#   find           In a push's queue-proof job: proven=true and run=<url> only when all of these hold, else proven=false.
#     1. A completed, successful workflow_dispatch run of this workflow file on a candidate/* branch has head_sha equal
#        to the pushed commit: the same tree and the same workflow definition. A cancelled run, a rerun whose final
#        conclusion is not success, a run of another workflow, event or branch never counts.
#     2. That run's own ci-comparison artifact says it compared with this branch (base-ref) at exactly the commit the
#        push starts from (BEFORE_SHA) and ran a full, affected or scoped plan. Its base is git merge-base, an ancestor
#        of the pushed commit, so base == BEFORE_SHA also makes the push a fast-forward from it. Another base-ref, an
#        older merge base, a forced-full run without a base, a docs or a proven plan never counts.
#     3. The commit the push starts from is green: the newest push run of this workflow on this branch for it
#        succeeded (its own gates, or a proof by these same rules). Red, unfinished or no run at all: the gates run,
#        because the next planner would compare with the last green push and re-test the unfixed part.
#   Every failed lookup is no proof: the gates run, and this step never fails the job.
#
# Only jobs of a run can upload artifacts into it, and the run is found by this workflow's id, its event, branch,
# commit and conclusion, so the record was written by this workflow file at this very commit.
set -euo pipefail

readonly RECORD_ARTIFACT=ci-comparison
readonly RECORD_FILE=comparison.json
scratch=''

record() {
  local file="${1:?Pass the record file}"
  : "${HEAD_SHA:?The planned commit is required}"
  : "${PLAN_MODE:?The plan mode is required}"
  mkdir -p "$(dirname "$file")"
  jq -n --arg head "$HEAD_SHA" --arg baseRef "${BASE_REF:-}" --arg base "${BASE_SHA:-}" --arg mode "$PLAN_MODE" \
    '{head: $head, "base-ref": $baseRef, base: $base, mode: $mode}' >"$file"
  echo "Recorded the comparison of $HEAD_SHA: $(jq -c . "$file")"
}

unproven() {
  echo "$1 The gates run."
  printf 'proven=false\n' >>"$GITHUB_OUTPUT"
  exit 0
}

find_proof() {
  : "${GITHUB_OUTPUT:?Actions output file is required}"
  local repository="${GITHUB_REPOSITORY:-}" branch="${GITHUB_REF_NAME:-}" head="${GITHUB_SHA:-}" before="${BEFORE_SHA:-}"
  if [[ ! "$head" =~ ^[0-9a-f]{40}$ || ! "$before" =~ ^[0-9a-f]{40}$ || "$before" == "$(printf '0%.0s' {1..40})" ]]; then
    unproven "This push names no earlier commit of $branch to start from."
  fi
  local workflow_id
  workflow_id="$(gh api "repos/$repository/actions/runs/${GITHUB_RUN_ID:-}" --jq '.workflow_id')" || workflow_id=''
  [[ "$workflow_id" =~ ^[0-9]+$ ]] || unproven 'The workflow of this run is unreadable.'

  # Rule 3: the newest push run of the previous head on this branch, by creation time, must have succeeded.
  local previous verdict
  previous="$(gh api --method GET "repos/$repository/actions/workflows/$workflow_id/runs" \
    -f "branch=$branch" -f event=push -f "head_sha=$before" -f per_page=100)" ||
    unproven "The push runs of $before are unreadable."
  verdict="$(jq -r --arg branch "$branch" --arg sha "$before" --argjson workflow "$workflow_id" '[.workflow_runs[]
    | select(.workflow_id == $workflow and .event == "push" and .head_branch == $branch and .head_sha == $sha)]
    | sort_by(.created_at) | last // {} | "\(.status // "none")/\(.conclusion // "none")"' <<<"$previous")" ||
    unproven "The push runs of $before are unreadable."
  [[ "$verdict" == completed/success ]] ||
    unproven "The push starts from $before, whose newest push run on $branch is $verdict, not green."

  # Rule 1: successful candidate dispatches of this workflow on this exact commit, newest first.
  local dispatches candidates
  dispatches="$(gh api --method GET "repos/$repository/actions/workflows/$workflow_id/runs" \
    -f event=workflow_dispatch -f "head_sha=$head" -f per_page=100)" ||
    unproven "The candidate runs of $head are unreadable."
  candidates="$(jq -r --arg sha "$head" --argjson workflow "$workflow_id" '.workflow_runs
    | map(select(.workflow_id == $workflow and .event == "workflow_dispatch" and .head_sha == $sha
      and (.head_branch | startswith("candidate/")) and .status == "completed" and .conclusion == "success"))
    | sort_by(.created_at) | reverse | .[] | select((.id | type) == "number") | "\(.id) \(.html_url)"' <<<"$dispatches")" ||
    unproven "The candidate runs of $head are unreadable."
  [[ -n "$candidates" ]] || unproven "No successful candidate/* dispatch of this workflow ran on $head."

  # Rule 2: the candidate's own record of what it compared with.
  local run_id url artifacts artifact record
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  while read -r run_id url; do
    artifacts="$(gh api --method GET "repos/$repository/actions/runs/$run_id/artifacts" -f "name=$RECORD_ARTIFACT")" ||
      { echo "The artifacts of $url are unreadable; it does not count."; continue; }
    artifact="$(jq -r --arg name "$RECORD_ARTIFACT" --arg sha "$head" --argjson run "$run_id" '[.artifacts[]
      | select(.name == $name and .expired == false and .workflow_run.id == $run and .workflow_run.head_sha == $sha)]
      | first | .id // empty' <<<"$artifacts")" || artifact=''
    if [[ ! "$artifact" =~ ^[0-9]+$ ]]; then
      echo "$url left no $RECORD_ARTIFACT record of what it compared with; it does not count."
      continue
    fi
    if ! gh api "repos/$repository/actions/artifacts/$artifact/zip" >"$scratch/record.zip" ||
      ! record="$(unzip -p "$scratch/record.zip" "$RECORD_FILE")"; then
      echo "The $RECORD_ARTIFACT record of $url is unreadable; it does not count."
      continue
    fi
    if jq -e --arg sha "$head" --arg branch "$branch" --arg before "$before" '.head == $sha and ."base-ref" == $branch and .base == $before
      and (.mode == "full" or .mode == "affected" or .mode == "scoped")' <<<"$record" >/dev/null 2>&1; then
      local message
      message="Run $url already proved $head: a successful candidate dispatch of this workflow on this exact commit, whose $(
        jq -r .mode <<<"$record"
      ) plan compared with $branch at $before, the green commit this push starts from. The gates are skipped."
      echo "$message"
      printf '## Proven commit\n\n%s\n' "$message" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
      printf 'proven=true\nrun=%s\n' "$url" >>"$GITHUB_OUTPUT"
      return 0
    fi
    echo "$url recorded $(jq -c . <<<"$record" 2>/dev/null || echo 'an unreadable comparison'), not $branch at $before; it does not count."
  done <<<"$candidates"
  unproven "No candidate run of $head compared with $branch at $before."
}

case "${1:-}" in
  record) record "${2:-}" ;;
  find) find_proof ;;
  *)
    echo 'Usage: commit-proof.sh record <file> | find' >&2
    exit 2
    ;;
esac
