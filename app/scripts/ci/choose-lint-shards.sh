#!/usr/bin/env bash
# The only rule deciding when a changed-file proof is insufficient, shared by gates and stage.
# Changed-file lint cannot catch an ordinary source edit making an untouched consumer fail a
# type-aware rule; the whole-tree shards in the gates catch that dependency propagation.
#
# External-input census (also exercised in ci-workflows.test.mts). Add new inputs here with new rules.
# Rule / policy                         Inputs                         Selector pattern below
# no-ambient-process-env,
# no-hand-parsed-environment-value      owner manifest + Modern config  package.json; modern.config.* (source)
# no-effect-run-in-tests                owner manifest + Rstest setup   package.json; rstest.config.* (source)
# no-unregistered-native-test-imports    Rstest + gates workflow + base/ *.json, *.y{a,}ml, source;
#                                      selected overlay + registered   includes ci-matrices*.json and its
#                                      files + imported matrix parser  ci-matrices*.mts/quality-cli-lifecycle.mts
# anti-slop-effect/no-service-          relative/@app data/passive      all JS/TS source + package.json;
# constructor-imports                  factories, registered tooling   includes ignored/generated source
#                                      entries and package source      outside the package's TS program
#                                      census (not just TS imports)
# import/{default,namespace,no-cycle,   resolved exports/import graph,  source + *.json/jsonc;
# no-named-as-default,                 manifests, resolver config       installed artifacts via lock/patches
# no-named-as-default-member,export}
# react-doctor/* selected by Ultracite  manifests, ts/jsconfig extends, source + JSON/JSONC/YAML/properties;
# (curated capabilities shared across  workspace, Nx/Expo/RN/framework package.json, nx/project/app.json,
# rules, including no-barrel-import,   metadata, barrel/project source android/gradle.properties, app.config.*
# only-export-components)              and HTML/MDX consumer census    and pnpm-workspace.{yaml,yml}
# react-doctor/no-img-without-dimensions sibling stylesheet imports     *.css/scss/sass/less/styl + markup
# repository managedSkillAssetPaths    skills lock + generated bundle  *.json + source (always whole-tree in gates)
# oxlint loader/native type-aware      configs, tsconfig extends/refs, config names + JSON/JSONC + source;
# bridge and compiler diagnostics      manifests, dependency artifacts lock/workspace/patches/toolchain
# oxfmt / Lefthook                     configs/ignore/discovery files config names + ignore files
#
# Other effect-native, anti-slop, GitHub, SonarJS, @nkzw and enabled Perfectionist rules inspect only
# the current file/program/options. Perfectionist's optional tsconfig readers (sort-imports/modules)
# are not enabled. Native type-aware rules share the package TS program; no extra data input found.
# Exact semantic import targets, symlink destinations, runtime env and files outside the checkout
# cannot be enumerated by a fixed path glob. Source/metadata/asset extensions below conservatively
# cover the checked-in inputs, not arbitrary out-of-tree state or a future nonstandard input suffix.
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
if [[ "${PLAN_MODE:?}" =~ ^(affected|scoped)$ && -s "${CHANGED_PATHS:?}" ]]; then
  shards='[0]'
  count=0
  # React Doctor's source/HTML/MDX census recognizes suffixes case-insensitively.
  shopt -s nocasematch
  while IFS= read -r -d '' path; do
    count=$((count + 1))
    # Oxfmt reads EditorConfig, formatter configs and prettierignore; oxlint reads eslintignore.
    # Gitignore also changes formatter directory discovery. Both tools ignore .ignore.
    if [[ "$path" =~ (^|/)(\.editorconfig|\.gitignore|\.eslintignore)$ ||
      "$path" =~ (^|/)[^/]*(prettier|oxlint|oxfmt|lefthook|tsgolint)[^/]*$ ||
      "$path" =~ \.([cm]?[jt]sx?|jsonc?|ya?ml|css|scss|sass|less|styl|html?|mdx|properties)$ ||
      "$path" == app/tools/oxlint/* || "$path" == app/patches/* ||
      "$path" =~ (^|/)(\.mise\.toml|mise\.toml|\.npmrc|\.node-version|\.tool-versions)$ ]]; then
      echo "::notice title=Lint policy input changed::$path can change how unchanged files lint; every tracked file is linted."
      shards='[1,2,3]'
      break
    fi
  done <"$CHANGED_PATHS"
  if ((count > 2000)); then shards='[1,2,3]'; fi
fi
echo "shards=$shards" >>"${GITHUB_OUTPUT:?}"
