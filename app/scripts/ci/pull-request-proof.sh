#!/usr/bin/env bash
# A merge queue entry of one pull request may carry exactly the tree that pull request's own run of this workflow
# already tested on the same base. Two subcommands, so the record and its reader share one format:
#
#   record <file>  In a pull_request run's ci-plan job, on the checked-out merge commit GitHub tested: its tree, its
#                  parents (the base it merged onto, the pull request head) and the final plan mode, as JSON. The
#                  workflow publishes the file as this run's ci-comparison artifact.
#   find           In a merge_group run's queue-proof job: proven=true and run=<url> only when all of these hold,
#                  else proven=false.
#     1. The queue ref gh-readonly-queue/main/pr-<N>-<base> names one pull request and the event's base commit.
#     2. Merging that pull request's current head onto the base gives exactly this entry's tree. A group of several
#        pull requests, a rebase that differs from the merge, a head that moved after the queue built the entry:
#        each gives another tree. This check runs here, on Git objects alone, never on the record: a run's record
#        is written by the workflow file of the commit that run tested, so it is only as honest as that tree. When
#        the head merged onto the base is this tree, every workflow line that run executed was this tree's or main's.
#     3. A completed, successful pull_request run of this workflow in this repository, from a head in this
#        repository, ran on that head. Its latest attempt decides; a cancelled or red rerun never counts.
#     4. Its own ci-comparison record says it tested this very tree, merged from that head onto this very base, with
#        a full or an affected plan. The planner reads only the tree and the changed paths between base and tree, so
#        the same tree on the same base plans exactly the gates this run would plan; a documentation plan never
#        counts.
#   Every failed lookup is no proof: the gates run, and this step never fails the job.
set -euo pipefail

readonly RECORD_ARTIFACT=ci-comparison
readonly RECORD_FILE=comparison.json
readonly QUEUE_REF='^refs/heads/gh-readonly-queue/main/pr-([0-9]+)-([0-9a-f]{40})$'
scratch=''

record() {
  local file="${1:?Pass the record file}"
  : "${PLAN_MODE:?The plan mode is required}"
  local tree base head
  tree="$(git rev-parse --verify 'HEAD^{tree}')"
  base="$(git rev-parse --verify 'HEAD^1^{commit}')"
  head="$(git rev-parse --verify 'HEAD^2^{commit}')"
  mkdir -p "$(dirname "$file")"
  jq -n --arg tree "$tree" --arg base "$base" --arg head "$head" --arg mode "$PLAN_MODE" \
    '{tree: $tree, base: $base, head: $head, mode: $mode}' >"$file"
  echo "Recorded what this run tests: $(jq -c . "$file")"
}

unproven() {
  echo "$1 The gates run."
  printf 'proven=false\n' >>"$GITHUB_OUTPUT"
  exit 0
}

find_proof() {
  : "${GITHUB_OUTPUT:?Actions output file is required}"
  local repository="${GITHUB_REPOSITORY:-}" ref="${GITHUB_REF:-}" sha="${GITHUB_SHA:-}" base="${BASE_SHA:-}"
  [[ "$ref" =~ $QUEUE_REF ]] || unproven "$ref names no merge queue entry of main."
  local number="${BASH_REMATCH[1]}"
  [[ "${BASH_REMATCH[2]}" == "$base" ]] || unproven "The queue ref $ref and the event's base $base disagree."
  [[ "$(git rev-parse --verify --quiet 'HEAD^{commit}')" == "$sha" ]] || unproven "The checkout is not $sha."

  # Rule 2, on Git objects alone.
  local tree head merged
  tree="$(git rev-parse --verify 'HEAD^{tree}')"
  git fetch --quiet --no-tags --filter=blob:none origin "+refs/pull/$number/head:refs/ci-proof/head" ||
    unproven "The head of pull request #$number is unreadable."
  head="$(git rev-parse --verify 'refs/ci-proof/head^{commit}')"
  # A clean merge prints only its tree; a conflict exits 1.
  merged="$(git merge-tree --write-tree "$base" "$head" 2>/dev/null)" || merged=''
  [[ "$merged" == "$tree" ]] ||
    unproven "Pull request #$number at $head merged onto $base is not this entry's tree $tree: the group holds more than this pull request, or the queue built another result."

  # Rule 3: successful pull_request runs of this workflow on that head, newest first.
  local workflow_id runs candidates
  workflow_id="$(gh api "repos/$repository/actions/runs/${GITHUB_RUN_ID:-}" --jq '.workflow_id')" || workflow_id=''
  [[ "$workflow_id" =~ ^[0-9]+$ ]] || unproven 'The workflow of this run is unreadable.'
  runs="$(gh api --method GET "repos/$repository/actions/workflows/$workflow_id/runs" \
    -f event=pull_request -f "head_sha=$head" -f per_page=100)" ||
    unproven "The pull request runs of $head are unreadable."
  candidates="$(jq -r --arg sha "$head" --arg repository "$repository" --argjson workflow "$workflow_id" '.workflow_runs
    | map(select(.workflow_id == $workflow and .event == "pull_request" and .head_sha == $sha
      and .repository.full_name == $repository and .head_repository.full_name == $repository
      and .status == "completed" and .conclusion == "success"))
    | sort_by(.created_at) | reverse | .[] | select((.id | type) == "number") | "\(.id) \(.html_url)"' <<<"$runs")" ||
    unproven "The pull request runs of $head are unreadable."
  [[ -n "$candidates" ]] || unproven "No successful pull request run of this workflow in $repository ran on $head."

  # Rule 4: the run's own record of what it tested. gh run download reads only that run's live artifact of that name.
  local run_id url record
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  while read -r run_id url; do
    if ! gh run download "$run_id" --repo "$repository" --name "$RECORD_ARTIFACT" --dir "$scratch/$run_id" >/dev/null ||
      ! record="$(cat "$scratch/$run_id/$RECORD_FILE")"; then
      echo "$url left no readable $RECORD_ARTIFACT record of what it tested; it does not count."
      continue
    fi
    if jq -e --arg tree "$tree" --arg base "$base" --arg head "$head" '.tree == $tree and .base == $base
      and .head == $head and (.mode == "full" or .mode == "affected")' <<<"$record" >/dev/null 2>&1; then
      local mode message
      mode="$(jq -r .mode <<<"$record")"
      message="Pull request run $url already passed every gate of this workflow on this exact tree $tree: #$number at $head merged onto $base, with a $mode plan. The gates are skipped."
      echo "$message"
      printf '## Proven tree\n\n%s\n' "$message" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
      printf 'proven=true\nrun=%s\n' "$url" >>"$GITHUB_OUTPUT"
      return 0
    fi
    echo "$url recorded $(jq -c . <<<"$record" 2>/dev/null || echo 'an unreadable record'), not tree $tree from $head onto $base with a full or affected plan; it does not count."
  done <<<"$candidates"
  unproven "No pull request run of $head recorded this tree on $base."
}

case "${1:-}" in
  record) record "${2:-}" ;;
  find) find_proof ;;
  *)
    echo 'Usage: pull-request-proof.sh record <file> | find' >&2
    exit 2
    ;;
esac
