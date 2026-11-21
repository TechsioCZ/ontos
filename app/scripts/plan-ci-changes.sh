#!/usr/bin/env bash
# This preflight uses only Git and jq. Documentation must not install the app to discover it needs no app checks.
set -euo pipefail

paths_file="${1:?Pass the changed-paths output file}"
: "${GITHUB_OUTPUT:?Actions output file is required}"
: >"$paths_file"

mode=full
reason='This event requires the complete suite.'
# The commit baselines are held to (Lean Core Dependencies): the exact comparison base when there is one.
comparison_base=
if [[ "${QUEUE_PROVEN:-false}" == true && "${FORCE_FULL:-false}" != true ]]; then
  mode=proven
  reason="${QUEUE_PROOF_RUN:?A proven commit names its proving run} already passed every gate of this workflow on this exact tree."
elif [[ "${FORCE_FULL:-false}" != true && "${GITHUB_EVENT_NAME:-}" =~ ^(pull_request|merge_group|push)$ ]]; then
  # GitHub tests a pull request as its merge into the current base, the merge commit's first parent.
  # The event's base.sha is the fork point instead: a shallow checkout lacks it, and it would count every
  # change the base gained since then as a change of this pull request.
  if [[ "${GITHUB_EVENT_NAME:-}" == pull_request ]]; then
    BASE_SHA=
    if git rev-parse --verify --quiet 'HEAD^2^{commit}' >/dev/null; then
      BASE_SHA="$(git rev-parse 'HEAD^1')"
    fi
  fi
  # A push the queue-proof job skipped (QUEUE_PROOF=skipped) is on a branch without a merge queue. GitHub keeps
  # one pending run per concurrency group there, so the commit before the push may never have had a run, or a red
  # or cancelled one. Such a push compares with the newest commit whose push run of this workflow on this branch
  # succeeded: every green run compared with an earlier green commit, so the diff covers every commit not yet
  # proven. No such ancestor among the 100 newest push runs, or any failed lookup, leaves no base: every gate runs.
  # The list is read unfiltered by status: with `status=success` it omitted a run that had ended green 24 s before,
  # and a queued push run starts exactly when the one before it ends.
  if [[ "${GITHUB_EVENT_NAME:-}" == push && "${QUEUE_PROOF:-}" == skipped ]]; then
    BASE_SHA=
    workflow_id="$(gh api "repos/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" --jq '.workflow_id')" || workflow_id=''
    proven=''
    if [[ "$workflow_id" =~ ^[0-9]+$ ]] &&
      runs="$(gh api --method GET "repos/${GITHUB_REPOSITORY:-}/actions/workflows/$workflow_id/runs" \
        -f "branch=${GITHUB_REF_NAME:-}" -f event=push -f per_page=100)"; then
      proven="$(jq -r --arg branch "${GITHUB_REF_NAME:-}" --argjson workflow "$workflow_id" '.workflow_runs
        | sort_by(.created_at) | reverse | .[]
        | select(.workflow_id == $workflow and .event == "push" and .head_branch == $branch
          and .status == "completed" and .conclusion == "success")
        | .head_sha' <<<"$runs")" || proven=''
    fi
    while IFS= read -r sha; do
      if [[ "$sha" =~ ^[0-9a-f]{40}$ && "$sha" != "${HEAD_SHA:-}" ]] && git merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
        BASE_SHA="$sha"
        echo "Comparing with $sha, the newest commit of this branch whose push run of this workflow succeeded."
        break
      fi
    done <<<"$proven"
    if [[ -z "$BASE_SHA" ]]; then
      echo "::warning title=Complete suite::No green push run of this workflow is on an ancestor of this commit; every gate runs."
    fi
  fi
  if [[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ && "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] &&
    git cat-file -e "$BASE_SHA^{commit}" &&
    git cat-file -e "$HEAD_SHA^{commit}" &&
    [[ "$(git rev-parse HEAD)" == "$HEAD_SHA" ]] &&
    git merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA" &&
    git diff --name-only --no-renames -z "$BASE_SHA" "$HEAD_SHA" >"$paths_file"; then
    comparison_base="$BASE_SHA"
    count=0
    documentation=true
    while IFS= read -r -d '' path; do
      count=$((count + 1))
      case "$path" in
        docs/* | CONTEXT-MAP.md | README.md | AGENTS.md) ;;
        *) documentation=false ;;
      esac
    done <"$paths_file"
    if [[ "$count" -gt 0 && "$documentation" == true ]]; then
      mode=docs
      reason='Every changed path is approved repository-root documentation.'
    elif [[ "$count" -gt 0 ]]; then
      mode=affected
      reason='Application impact must be resolved from the complete changed-path list.'
    else
      reason='An empty diff does not establish documentation-only impact.'
    fi
  else
    reason='The exact comparison is unavailable; the complete suite is required.'
  fi
fi

# Without an exact comparison, schedule and dispatch runs and a push on a branch with a merge queue hold
# baselines to the first parent: every commit pushed behind the queue already passed it against the queue's
# base, so a multi-commit entry whose event.before lies outside the checkout is no reason to fail. ci-plan
# checks exactly these runs out two commits deep, so the parent is present. A push on a branch without a merge
# queue and without a green ancestor names no base: what is unproven there can be any number of commits, so
# the check that needs a base fails. This names a commit only; mode, reason and the changed paths stay those
# of the comparison above.
if [[ -z "$comparison_base" ]] &&
  [[ "${GITHUB_EVENT_NAME:-}" == schedule || "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ||
    ("${GITHUB_EVENT_NAME:-}" == push && "${QUEUE_PROOF:-}" != skipped) ]]; then
  comparison_base="$(git rev-parse --verify --quiet 'HEAD^1^{commit}')" || comparison_base=''
fi

# A formatter, linter or hook configuration reformats or re-lints files nobody touched: the one real
# failure a changed-file lint would miss. Such a run, the nightly run and any run without the exact
# changed-path list lint every tracked file. The planner reads this to keep the lint slot's successors off
# a sweep that holds it for minutes.
lint_sweep=changed
changed=0
while IFS= read -r -d '' path; do
  changed=$((changed + 1))
  if [[ "$path" =~ (^|/)[^/]*(prettier|oxlint|oxfmt|lefthook)[^/]*$ ||
    "$path" == app/tools/oxlint/* || "$path" == app/patches/* ||
    "$path" =~ ^app/tsconfig[^/]*\.json$ ||
    "$path" == app/pnpm-lock.yaml || "$path" == app/pnpm-workspace.yaml || "$path" == app/.mise.toml ]]; then
    lint_sweep=all
  fi
done <"$paths_file"
# 2000 paths exceed one lefthook argument list.
if [[ "${GITHUB_EVENT_NAME:-}" == schedule || "$changed" -eq 0 || "$changed" -gt 2000 ]]; then
  lint_sweep=all
fi

printf 'mode=%s\n' "$mode" >>"$GITHUB_OUTPUT"
printf 'lintSweep=%s\n' "$lint_sweep" >>"$GITHUB_OUTPUT"
printf 'reason=%s\n' "$reason" >>"$GITHUB_OUTPUT"
printf 'base=%s\n' "$comparison_base" >>"$GITHUB_OUTPUT"
if [[ "$mode" == docs || "$mode" == proven ]]; then
  jq -cn '{
    "workspace-gate":"skipped", "workspace-unit":"skipped", "static-contracts":"skipped",
    "format-and-lint":"skipped", "service-integration":"skipped",
    "node-artifact-build":"skipped"
  }' | sed 's/^/expected=/' >>"$GITHUB_OUTPUT"
  printf 'source=[]\nunit=[]\nunitAfterLint=[]\nunitAfterStatic=[]\nunitAfterTooling=[]\nintegration=[]\nintegrationBrowser=[]\nintegrationBrowserAfterStatic=[]\nintegrationBuild=[]\nintegrationOwners=[]\nintegrationTopology=[]\nlint=[]\n' >>"$GITHUB_OUTPUT"
fi
printf '%s\n' "$reason"
