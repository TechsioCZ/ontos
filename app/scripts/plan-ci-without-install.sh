#!/usr/bin/env bash
# The plan job's planner, run from app/ before anything is installed: hosted Ubuntu 24.04's Node strips the types of
# scripts/plan-ci-checks.mts and scripts/ci/ci-matrices-rules.mts, which import nothing outside the repository. This
# glue reads the environment and the authored JSON, checks every value the planner reads against the contracts those
# modules declare (CI_MATRICES_FIELDS, CI_WORKSPACE_FIELDS), writes the outputs and the summary, and fails on
# matrices the planner cannot plan from. The checks live here because they branch on JSON types with typeof, which the
# repository lint (anti-slop/no-runtime-typeof) keeps out of linted code; app/scripts/tests/ci-change-plan.test.mts
# runs this script against broken inputs and holds its verdicts to the Effect decode's.
# Usage: plan-ci-without-install.sh --paths-file <NUL-separated paths> [--full] [--apply-affected]
set -euo pipefail
node --input-type=module - "$@" <<'JS'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { CI_MATRICES_FIELDS, checkedCiMatrices } from './scripts/ci/ci-matrices-rules.mts';
import {
  CI_WORKSPACE_FIELDS, ciPlanOutputs, ciPlanSummary, ciWorkspacePackages, planCiChecks, workspacePackageDirectories,
} from './scripts/plan-ci-checks.mts';

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'apply-affected': { default: false, type: 'boolean' },
    full: { default: false, type: 'boolean' },
    'paths-file': { type: 'string' },
  },
});
if (flags['paths-file'] === undefined) {
  throw new Error('--paths-file names the NUL-separated changed paths');
}
const environment = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
};

const isMap = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const entriesOf = (value, contract, at, problems) =>
  Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, checked(entry, contract, `${at}.${key}`, problems)]),
  );
// The value as its contract reads it, every object rebuilt in the contract's key order as the Effect decode
// rebuilds it; each way it breaks the contract is added to problems.
const checked = (value, contract, at, problems) => {
  if ('primitive' in contract) {
    if (typeof value !== contract.primitive) {
      problems.push(`${at} must be a ${contract.primitive}`);
    }
    return value;
  }
  if ('literals' in contract) {
    if (!contract.literals.includes(value)) {
      problems.push(`${at} must be one of ${contract.literals.join(', ')}`);
    }
    return value;
  }
  if ('tree' in contract) {
    if (Array.isArray(value)) {
      return value.map((entry, index) => checked(entry, contract, `${at}[${index}]`, problems));
    }
    return isMap(value) ? entriesOf(value, contract, at, problems) : checked(value, contract.tree, at, problems);
  }
  if ('list' in contract) {
    if (!Array.isArray(value)) {
      problems.push(`${at} must be a list`);
      return value;
    }
    if (contract.nonEmpty === true && value.length === 0) {
      problems.push(`${at} must not be empty`);
    }
    return value.map((entry, index) => checked(entry, contract.list, `${at}[${index}]`, problems));
  }
  if (!isMap(value)) {
    problems.push(`${at} must be an object`);
    return value;
  }
  if ('map' in contract) {
    return entriesOf(value, contract.map, at, problems);
  }
  if (contract.closed) {
    for (const key of Object.keys(value).filter((key) => !Object.hasOwn(contract.fields, key))) {
      problems.push(`${at} has the unknown key ${key}`);
    }
  }
  return Object.fromEntries(
    Object.entries(contract.fields).flatMap(([key, field]) => {
      if (Object.hasOwn(value, key)) {
        return [[key, checked(value[key], field.value, `${at}.${key}`, problems)]];
      }
      if (field.optional !== true) {
        problems.push(`${at} lacks the key ${key}`);
      }
      return [];
    }),
  );
};
// The JSON file as its contract reads it, or an error naming every way it breaks the contract.
const read = (file, fields, closed) => {
  const problems = [];
  const value = checked(JSON.parse(readFileSync(file, 'utf8')), { closed, fields }, file, problems);
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
  return value;
};
// Every path string of a checked exports value, through condition maps and fallback lists.
const paths = (target) => (typeof target === 'string' ? [target] : Object.values(target ?? {}).flatMap(paths));

const overlay = process.env.CI_MATRICES_OVERLAY ?? '';
let merged;
try {
  merged = checkedCiMatrices(
    read('scripts/ci-matrices.json', CI_MATRICES_FIELDS.matrices, true),
    overlay === '' ? undefined : read(overlay, CI_MATRICES_FIELDS.overlay, true),
  );
} catch (error) {
  merged = { invalid: String(error) };
}
if ('invalid' in merged) {
  console.error(merged.invalid);
  process.exit(1);
}
const templates = merged.matrices;
const changedPaths = readFileSync(flags['paths-file'], 'utf8').split('\0').filter(Boolean);
let packages = [];
try {
  const workspace = workspacePackageDirectories(
    readFileSync('pnpm-workspace.yaml', 'utf8'),
    (directory) => readdirSync(directory),
    (directory) => existsSync(`${directory}/package.json`),
  );
  if ('unreadable' in workspace) {
    throw new Error(workspace.unreadable);
  }
  packages = ciWorkspacePackages({
    manifests: workspace.directories.map((directory) => {
      const manifest = read(`${directory}/package.json`, CI_WORKSPACE_FIELDS.manifest, false);
      return { directory, manifest: { ...manifest, exportPaths: paths(manifest.exports) } };
    }),
    owners: read('topology/ownership.json', CI_WORKSPACE_FIELDS.ownership, false).owners,
    rootPackages: templates['root-packages'],
    topology: read('topology/reference-topology.json', CI_WORKSPACE_FIELDS.topology, false),
  });
} catch (error) {
  console.log(`Workspace impact is unavailable: ${String(error)}. Running the complete suite.`);
}
const plan = planCiChecks({
  applyAffected: flags['apply-affected'],
  changedPaths,
  forceFull: flags.full,
  packages,
  templates,
});
const outputs = Object.entries(ciPlanOutputs(plan)).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
appendFileSync(environment('GITHUB_OUTPUT'), `mode=${plan.mode}\n${outputs.join('\n')}\n`);
appendFileSync(environment('GITHUB_STEP_SUMMARY'), ciPlanSummary(plan, templates));
console.log(plan.reason);
JS
