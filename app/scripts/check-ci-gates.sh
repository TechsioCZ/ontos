#!/usr/bin/env bash
set -euo pipefail
: "${NEEDS_JSON:?Actions job results are required}"

# Compare every gate with the explicit plan. Neither missing outputs nor arbitrary skipped jobs pass.
jq -e '
  . as $needs |
  .["queue-proof"] as $proof |
  .["ci-plan"] as $plan |
  ($plan.outputs.expected | fromjson) as $expected |
  ($plan.outputs.unitAfterLint | fromjson) as $unitAfterLint |
  ($plan.outputs.unitAfterStatic | fromjson) as $unitAfterStatic |
  ($plan.outputs.unitAfterTopology | fromjson) as $unitAfterTopology |
  ($plan.outputs.integrationEarly | fromjson) as $integrationEarly |
  [
    "workspace-gate", "workspace-unit", "static-contracts", "format-and-lint",
    "service-integration", "node-artifact-build"
  ] as $gates |
  ($proof.result == "success" or $proof.result == "skipped") and
  $plan.result == "success" and
  (($expected | keys | sort) == ($gates | sort)) and
  (($needs | keys | sort) == (["workspace-unit-after-lint", "workspace-unit-after-static", "workspace-unit-after-topology", "service-integration-early", "queue-proof", "ci-plan", "node-topology-proof", "service-integration-setup"] + $gates | sort)) and
  (($unitAfterLint | type) == "array") and
  ($needs["workspace-unit-after-lint"].result == (if ($unitAfterLint | length) > 0 then $expected["workspace-unit"] else "skipped" end)) and
  (($unitAfterStatic | type) == "array") and
  ($needs["workspace-unit-after-static"].result == (if ($unitAfterStatic | length) > 0 then $expected["workspace-unit"] else "skipped" end)) and
  (($unitAfterTopology | type) == "array") and
  ($needs["workspace-unit-after-topology"].result == (if ($unitAfterTopology | length) > 0 then $expected["workspace-unit"] else "skipped" end)) and
  (($integrationEarly | type) == "array") and
  ($needs["service-integration-early"].result == (if ($integrationEarly | length) > 0 then $expected["service-integration"] else "skipped" end)) and
  ($needs["node-topology-proof"].result == $expected["service-integration"]) and
  ($needs["service-integration-setup"].result == $expected["service-integration"]) and
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
      all($expected | to_entries[] | select(.key != "service-integration"); .value == "success")
    else false end
  ) and
  all($gates[]; . as $gate | $needs[$gate].result == $expected[$gate])
' <<<"$NEEDS_JSON" >/dev/null || {
  echo '::error title=Workspace gates failed::Job results do not satisfy the validated CI plan.'
  exit 1
}
echo 'Every selected gate passed and every skip was planned.'
