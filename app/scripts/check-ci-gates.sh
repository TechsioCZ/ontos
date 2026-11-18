#!/usr/bin/env bash
set -euo pipefail
: "${NEEDS_JSON:?Actions job results are required}"

# Compare every gate with the explicit plan. Neither missing outputs nor arbitrary skipped jobs pass.
# A helper job that runs a planned list (unit rows behind a freed slot, owner rows, browser checks) must
# match its gate when the list has rows and must be skipped when the plan left it empty.
jq -e '
  . as $needs |
  .["queue-proof"] as $proof |
  .["ci-plan"] as $plan |
  ($plan.outputs.expected | fromjson) as $expected |
  [
    "workspace-gate", "workspace-unit", "static-contracts", "format-and-lint",
    "service-integration", "node-artifact-build"
  ] as $gates |
  [
    ["workspace-unit-after-lint", "unitAfterLint", "workspace-unit"],
    ["workspace-unit-after-static", "unitAfterStatic", "workspace-unit"],
    ["workspace-unit-after-tooling", "unitAfterTooling", "workspace-unit"],
    ["owner-integration", "integrationOwners", "service-integration"],
    ["browser-integration", "integrationBrowser", "service-integration"],
    ["browser-integration-after-static", "integrationBrowserAfterStatic", "service-integration"]
  ] as $planned |
  ($proof.result == "success" or $proof.result == "skipped") and
  $plan.result == "success" and
  (($expected | keys | sort) == ($gates | sort)) and
  (($needs | keys | sort) == (["queue-proof", "ci-plan", "workspace-source-contracts", "node-topology-proof"] + [$planned[][0]] + $gates | sort)) and
  ($needs["workspace-source-contracts"].result == $expected["workspace-gate"]) and
  ($needs["node-topology-proof"].result == $expected["service-integration"]) and
  all($planned[]; . as [$job, $output, $gate] |
    ($plan.outputs[$output] | fromjson) as $rows |
    ($rows | type) == "array" and
    $needs[$job].result == (if ($rows | length) > 0 then $expected[$gate] else "skipped" end)) and
  (all($expected[]; . == "success" or . == "skipped")) and
  (
    if $plan.outputs.mode == "proven" then
      $proof.result == "success" and $proof.outputs.proven == "true" and
      all($expected[]; . == "skipped")
    elif $plan.outputs.mode == "docs" then
      $proof.outputs.proven != "true" and all($expected[]; . == "skipped")
    elif $plan.outputs.mode == "full" then
      all($expected[]; . == "success")
    elif $plan.outputs.mode == "tooling" then
      $proof.outputs.proven != "true" and
      all($expected | to_entries[];
        .value == (if (.key == "workspace-unit" or .key == "node-artifact-build" or .key == "service-integration")
          then "skipped" else "success" end)) and
      all(["unit", "unitAfterLint", "unitAfterStatic", "unitAfterTooling",
        "integration", "integrationBuild", "integrationOwners", "integrationBrowser",
        "integrationBrowserAfterStatic", "integrationTopology"][];
        ($plan.outputs[.] | fromjson) == [])
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
