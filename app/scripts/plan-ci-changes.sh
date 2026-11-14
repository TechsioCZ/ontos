#!/usr/bin/env bash
# This preflight uses only Git and jq. Documentation must not install the app to discover it needs no app checks.
# A manual dispatch is a complete run, except a candidate/* dispatch whose workflow resolved a comparison point
# (CANDIDATE_DISPATCH=true with BASE_SHA set): it is classified like a pull request against that point.
set -euo pipefail

paths_file="${1:?Pass the changed-paths output file}"
: "${GITHUB_OUTPUT:?Actions output file is required}"
: >"$paths_file"

mode=full
reason='This event requires the complete suite.'
if [[ "${QUEUE_PROVEN:-false}" == true && "${FORCE_FULL:-false}" != true ]]; then
  mode=proven
  reason='The merge queue already proved this exact commit.'
elif [[ "${FORCE_FULL:-false}" != true &&
  ("${GITHUB_EVENT_NAME:-}" =~ ^(pull_request|merge_group|push)$ ||
  ("${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${CANDIDATE_DISPATCH:-false}" == true)) ]]; then
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

printf 'mode=%s\n' "$mode" >>"$GITHUB_OUTPUT"
printf 'reason=%s\n' "$reason" >>"$GITHUB_OUTPUT"
if [[ "$mode" == docs || "$mode" == proven ]]; then
  jq -cn '{
    "workspace-gate":"skipped", "workspace-unit":"skipped", "workspace-unit-artifacts":"skipped",
    "static-contracts":"skipped", "format-and-lint":"skipped", "service-integration":"skipped",
    "seeded-integration":"skipped", "integration-seed-proof":"skipped", "browser-integration":"skipped",
    "node-artifact-build":"skipped", "node-artifact-proof":"skipped"
  }' | sed 's/^/expected=/' >>"$GITHUB_OUTPUT"
  printf 'source=[]\nunit=[]\nunit-artifacts=[]\nintegration=[]\nseeded-integration=[]\nbrowser=[]\n' >>"$GITHUB_OUTPUT"
fi
printf '%s\n' "$reason"
