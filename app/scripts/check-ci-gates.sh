#!/usr/bin/env bash
set -euo pipefail
: "${NEEDS_JSON:?Actions job results are required}"

# Compare every gate with the explicit plan. Neither missing outputs nor arbitrary skipped jobs pass.
jq -e '
  . as $needs |
  .["queue-proof"] as $proof |
  .["ci-plan"] as $plan |
  ($plan.outputs.expected | fromjson) as $expected |
  ($plan.outputs.unitAfterPreparation | fromjson) as $unitAfter |
  ($plan.outputs.integrationAfterContracts | fromjson) as $afterContracts |
  ($plan.outputs.integrationAfterTooling | fromjson) as $afterTooling |
  [
    "workspace-gate", "workspace-unit", "static-contracts", "format-and-lint",
    "service-integration", "node-artifact-build"
  ] as $gates |
  ($proof.result == "success" or $proof.result == "skipped") and
  $plan.result == "success" and
  (($expected | keys | sort) == ($gates | sort)) and
  (($needs | keys | sort) == (["workspace-source-extra", "workspace-unit-after-preparation", "service-integration-after-contracts", "service-integration-after-tooling", "queue-proof", "ci-plan", "node-artifact-build-remaining", "node-topology-proof", "service-integration-setup"] + $gates | sort)) and
  ($needs["workspace-source-extra"].result == $expected["workspace-gate"]) and
  (($unitAfter | type) == "array") and
  ($needs["workspace-unit-after-preparation"].result == (if ($unitAfter | length) > 0 then $expected["workspace-unit"] else "skipped" end)) and
  (($afterContracts | type) == "array") and
  (($afterTooling | type) == "array") and
  ($needs["service-integration-after-contracts"].result == (if ($afterContracts | length) > 0 then $expected["service-integration"] else "skipped" end)) and
  ($needs["service-integration-after-tooling"].result == (if ($afterTooling | length) > 0 then $expected["service-integration"] else "skipped" end)) and
  ($needs["node-artifact-build-remaining"].result == $expected["node-artifact-build"]) and
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
