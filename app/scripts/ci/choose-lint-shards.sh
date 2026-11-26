#!/usr/bin/env bash
# The only rule deciding when a changed-file proof is insufficient, shared by gates and stage.
set -euo pipefail
shards='[1,2,3]'
# Only an exact SHA already verified by this workflow earns the global-only proof row. An empty
# path file alone also means unknown/divergent/truncated history, which must keep all three shards.
if [[ "${PLAN_MODE:?}" =~ ^(affected|scoped)$ && ! -s "${CHANGED_PATHS:?}" &&
  -n "${COMPARISON_SNAPSHOT:-}" && -n "${GITHUB_SHA:-}" ]] &&
  jq -e --arg head "$GITHUB_SHA" '.comparison | .base == $head and .ancestor == true and
    .truncated == false and .changedPaths == []' "$COMPARISON_SNAPSHOT" >/dev/null 2>&1; then
  shards='["proof"]'
fi
if [[ "${PLAN_MODE:?}" =~ ^(affected|scoped)$ && -s "${CHANGED_PATHS:?}" ]]; then
  shards='[0]'
  count=0
  while IFS= read -r -d '' path; do
    count=$((count + 1))
    # Oxfmt reads EditorConfig, formatter configs and prettierignore; oxlint reads eslintignore.
    # Gitignore also changes formatter directory discovery. Both tools ignore .ignore.
    if [[ "$path" =~ (^|/)(\.editorconfig|\.gitignore|\.eslintignore)$ ||
      "$path" =~ (^|/)[^/]*(prettier|oxlint|oxfmt|lefthook|tsgolint)[^/]*$ ||
      "$path" =~ (^|/)tsconfig[^/]*\.json$ || "$path" == app/tools/oxlint/* || "$path" == app/patches/* ||
      "$path" == app/package.json || "$path" == app/pnpm-lock.yaml || "$path" == app/pnpm-workspace.yaml ||
      "$path" == app/.mise.toml ]]; then
      echo "::notice title=Tool configuration changed::$path changes how unchanged files lint; every tracked file is linted."
      shards='[1,2,3]'
      break
    fi
  done <"$CHANGED_PATHS"
  if ((count > 2000)); then shards='[1,2,3]'; fi
fi
echo "shards=$shards" >>"${GITHUB_OUTPUT:?}"
