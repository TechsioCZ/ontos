#!/usr/bin/env bash
# This preflight uses only Git and jq. Documentation must not install the app to discover it needs no app checks.
set -euo pipefail

paths_file="${1:?Pass the changed-paths output file}"
: "${GITHUB_OUTPUT:?Actions output file is required}"
: >"$paths_file"

mode=full
reason='This event requires the complete suite.'
if [[ "${QUEUE_PROVEN:-false}" == true && "${FORCE_FULL:-false}" != true ]]; then
  mode=proven
  if [[ "${GITHUB_EVENT_NAME:-}" == merge_group ]]; then
    reason='A green pull request run already tested this exact tree on this exact base.'
  else
    reason='The merge queue already proved this exact commit.'
  fi
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
  if [[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ && "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] &&
    git cat-file -e "$BASE_SHA^{commit}" &&
    git cat-file -e "$HEAD_SHA^{commit}" &&
    [[ "$(git rev-parse HEAD)" == "$HEAD_SHA" ]] &&
    git merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA" &&
    git diff --name-only --no-renames -z "$BASE_SHA" "$HEAD_SHA" >"$paths_file"; then
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
if [[ "$mode" == docs || "$mode" == proven ]]; then
  jq -cn '{
    "workspace-gate":"skipped", "workspace-unit":"skipped", "static-contracts":"skipped",
    "format-and-lint":"skipped", "service-integration":"skipped",
    "node-artifact-build":"skipped"
  }' | sed 's/^/expected=/' >>"$GITHUB_OUTPUT"
  printf 'source=[]\nunit=[]\nunitAfterLint=[]\nunitAfterStatic=[]\nunitAfterTooling=[]\nintegration=[]\nintegrationBrowser=[]\nintegrationBuild=[]\nintegrationOwners=[]\nintegrationTopology=[]\n' >>"$GITHUB_OUTPUT"
fi
printf '%s\n' "$reason"
