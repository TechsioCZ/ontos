#!/usr/bin/env bash
# Code needs every slice: native-external-inputs.test.mts proves package manifests,
# Modern configuration and CI matrix registration change untouched-file findings.
# Markdown stays documentation; markdown-modules.test.mts checks that premise.
set -euo pipefail
shards='[1,2,3]'
if [[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && -n "${COMPARISON_SNAPSHOT:-}" && -n "${GITHUB_SHA:-}" ]] &&
  jq -e --arg head "$GITHUB_SHA" '.comparison | .base == $head and .ancestor == true and
    .truncated == false and .changedPaths == []' "$COMPARISON_SNAPSHOT" >/dev/null 2>&1; then
  shards='["proof"]'
elif [[ "${GITHUB_EVENT_NAME:-}" == push && -n "${COMPARISON_SNAPSHOT:-}" && -n "${GITHUB_SHA:-}" ]] &&
  jq -e --arg head "$GITHUB_SHA" '.comparison | .ancestor == true and .truncated == false and .base != $head and
    (.base | type == "string" and test("^[a-f0-9]{40}\\z")) and
    (.changedPaths | type == "array" and length > 0 and
      all(.[]; type == "string" and endswith(".md") and (contains("\u0000") | not)))' "$COMPARISON_SNAPSHOT" >/dev/null 2>&1; then
  # The history reader rejects malformed compare records before creating changedPaths.
  jq -j '.comparison.changedPaths[] | ., "\u0000"' "$COMPARISON_SNAPSHOT" >"${CHANGED_PATHS:?}"
  shards='["docs"]'
fi
echo "shards=$shards" >>"${GITHUB_OUTPUT:?}"
