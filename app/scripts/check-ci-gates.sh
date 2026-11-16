#!/usr/bin/env bash
set -euo pipefail
: "${NEEDS_JSON:?Actions job results are required}"

# Compare every gate with the explicit plan. Neither missing outputs nor arbitrary skipped jobs pass.
jq -e '
  . as $needs |
  .["queue-proof"] as $proof |
  .["ci-plan"] as $plan |
  ($plan.outputs.expected | fromjson) as $expected |
  [
    "workspace-gate", "workspace-unit", "workspace-unit-artifacts", "static-contracts", "format-and-lint",
    "service-integration", "integration-seed-proof", "browser-integration",
    "node-artifact-build", "node-artifact-proof"
  ] as $gates |
  # Test matrices an affected plan may leave without rows, and the seed producer, which runs exactly when an
  # integration row does; every other gate always runs outside a no-op plan.
  ["workspace-unit", "workspace-unit-artifacts", "service-integration", "integration-seed-proof",
    "browser-integration"] as $optional |
  ($proof.result == "success" or $proof.result == "skipped") and
  $plan.result == "success" and
  (($expected | keys | sort) == ($gates | sort)) and
  (($needs | keys | sort) == (["queue-proof", "ci-plan"] + $gates | sort)) and
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
    else false end
  ) and
  all($gates[]; . as $gate | $needs[$gate].result == $expected[$gate])
' <<<"$NEEDS_JSON" >/dev/null || {
  echo '::error title=Workspace gates failed::Job results do not satisfy the validated CI plan.'
  exit 1
}
echo 'Every selected gate passed and every skip was planned.'
