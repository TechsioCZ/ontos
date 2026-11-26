#!/usr/bin/env bash
# Stage proof selector: only a manual dispatch of the exact verified SHA can run global jobs alone.
# Every other comparison requires all whole-tree slices, including documentation-only changes
# (native-external-inputs.test.mts proves a regular Markdown import can change an untouched finding).
set -euo pipefail
shards='[1,2,3]'
if [[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && -n "${COMPARISON_SNAPSHOT:-}" && -n "${GITHUB_SHA:-}" ]] &&
  jq -e --arg head "$GITHUB_SHA" '.comparison | .base == $head and .ancestor == true and
    .truncated == false and .changedPaths == []' "$COMPARISON_SNAPSHOT" >/dev/null 2>&1; then
  shards='["proof"]'
fi
echo "shards=$shards" >>"${GITHUB_OUTPUT:?}"
