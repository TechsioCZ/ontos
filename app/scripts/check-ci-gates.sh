#!/usr/bin/env bash
set -euo pipefail
: "${NEEDS_JSON:?Actions job results are required}"

# Compare every gate with the explicit plan. Neither missing outputs nor arbitrary skipped jobs pass.
# A job that runs a planned list (owner rows, the bootstrap row, browser checks) must succeed when the list has rows
# and must be skipped when the plan left it empty.
jq -e '
  . as $needs |
  .["queue-proof"] as $proof |
  .["ci-plan"] as $plan |
  ($plan.outputs.expected | fromjson) as $expected |
  [
    "workspace-gate", "workspace-unit", "workspace-unit-artifacts", "static-contracts", "format-and-lint",
    "service-integration", "node-artifact-build"
  ] as $gates |
  [
    ["owner-integration", "integrationOwners"],
    ["browser-integration", "integrationBrowser"],
    ["node-topology-proof", "integrationTopology"]
  ] as $planned |
  # Test matrices an affected plan may leave without rows; every other gate always runs outside a no-op plan.
  ["workspace-unit", "workspace-unit-artifacts", "service-integration"] as $optional |
  ($proof.result == "success" or $proof.result == "skipped") and
  $plan.result == "success" and
  (($expected | keys | sort) == ($gates | sort)) and
  (($needs | keys | sort) == (["queue-proof", "ci-plan"] + [$planned[][0]] + $gates | sort)) and
  all($planned[]; . as [$job, $output] |
    ($plan.outputs[$output] | fromjson) as $rows |
    ($rows | type) == "array" and
    $needs[$job].result == (if ($rows | length) > 0 then "success" else "skipped" end)) and
  (all($expected[]; . == "success" or . == "skipped")) and
  (
    if $plan.outputs.mode == "proven" then
      $proof.result == "success" and $proof.outputs.proven == "true" and
      all($expected[]; . == "skipped")
    elif $plan.outputs.mode == "docs" then
      $proof.outputs.proven != "true" and all($expected[]; . == "skipped")
    elif $plan.outputs.mode == "full" then
      all($expected[]; . == "success")
    elif $plan.outputs.mode == "affected" then
      $proof.outputs.proven != "true" and
      all($expected | to_entries[] | select(.key as $key | $optional | index($key) | not); .value == "success") and
      any($expected | to_entries[] | select(.key == "workspace-unit" or .key == "workspace-unit-artifacts"); .value == "success")
    # A diff inside the scopes of scripts/ci-matrices.json builds no unit: its source rows, the static contracts and
    # the lint row (the changed files, the lint rule tests and the whole-tree repository policy) always run.
    elif $plan.outputs.mode == "scoped" then
      $proof.outputs.proven != "true" and
      all(["workspace-gate", "static-contracts", "format-and-lint"][]; $expected[.] == "success")
    else false end
  ) and
  all($gates[]; . as $gate | $needs[$gate].result == $expected[$gate])
' <<<"$NEEDS_JSON" >/dev/null || {
  echo '::error title=Workspace gates failed::Job results do not satisfy the validated CI plan.'
  exit 1
}
echo 'Every selected gate passed and every skip was planned.'
