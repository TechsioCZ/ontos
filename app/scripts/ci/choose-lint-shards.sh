#!/usr/bin/env bash
# Both workflows lint the whole tree, even for narrowed plans. Outside inputs include
# anti-slop-effect/no-service-constructor-imports' package census and explicit imports of arbitrary suffixes,
# no-unregistered-native-test-imports' matrices/workflow, and import/no-cycle's Vue/Svelte/Astro imports.
# Formatter configuration can also come through a symlink. A path denylist cannot exhaust these inputs.
# Docs audit: format checks Markdown itself, lint's globs exclude it, and shell-ui-candidates scans
# vertical source/CSS only. But the enabled service-constructor rule reads explicit .md imports:
# changing regular app/docs/parser.md can fail an untouched importer (native-external-inputs.test.mts).
# Documentation is therefore not inert. No documentation exception is granted, even with no tracked symlinks.
set -euo pipefail
shards='[1,2,3]'
# Only an exact SHA already verified by this workflow earns the global-only proof row. An empty
# path file alone also means unknown/divergent/truncated history, which must keep all three shards.
if [[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${PLAN_MODE:?}" =~ ^(affected|scoped)$ && ! -s "${CHANGED_PATHS:?}" &&
  -n "${COMPARISON_SNAPSHOT:-}" && -n "${GITHUB_SHA:-}" ]] &&
  jq -e --arg head "$GITHUB_SHA" '.comparison | .base == $head and .ancestor == true and
    .truncated == false and .changedPaths == []' "$COMPARISON_SNAPSHOT" >/dev/null 2>&1; then
  shards='["proof"]'
fi
echo "shards=$shards" >>"${GITHUB_OUTPUT:?}"
