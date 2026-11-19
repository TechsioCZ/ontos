#!/usr/bin/env bash
# The plan job's planner, run from app/ before anything is installed: hosted Ubuntu 24.04's Node strips the types of
# scripts/plan-ci-checks.mts and scripts/ci/ci-matrices-rules.mts, which import nothing outside the repository. This
# glue reads the environment and the authored JSON, writes the outputs and the summary, and fails on matrices the
# planner cannot plan from. Usage: plan-ci-without-install.sh --paths-file <NUL-separated paths> [--full] [--apply-affected]
set -euo pipefail
node --input-type=module - "$@" <<'JS'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { CI_MATRICES_KEYS, checkedCiMatrices } from './scripts/ci/ci-matrices-rules.mts';
import {
  ciPlanOutputs, ciPlanSummary, ciWorkspacePackages, planCiChecks, workspacePackageDirectories,
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
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
// The installed tools decode each row with its keys in the declared order, and the outputs carry the rows as decoded.
const ordered = (entries, kind) =>
  entries?.map((entry) => Object.fromEntries(Object.entries(entry).toSorted(
    ([left], [right]) => kind.allowed.indexOf(left) - kind.allowed.indexOf(right),
  )));
const matrices = (file) => {
  const document = read(file);
  return {
    ...document,
    integration: ordered(document.integration, CI_MATRICES_KEYS.integration),
    source: ordered(document.source, CI_MATRICES_KEYS.command),
    unit: ordered(document.unit, CI_MATRICES_KEYS.command),
  };
};
// Every path string of a package's exports value, through condition maps and fallback lists.
const paths = (target) => (typeof target === 'string' ? [target] : Object.values(target ?? {}).flatMap(paths));

const overlay = process.env.CI_MATRICES_OVERLAY ?? '';
const checked = checkedCiMatrices(matrices('scripts/ci-matrices.json'), overlay === '' ? undefined : matrices(overlay));
if ('invalid' in checked) {
  console.error(checked.invalid);
  process.exit(1);
}
const templates = checked.matrices;
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
      const manifest = read(`${directory}/package.json`);
      return { directory, manifest: { ...manifest, exportPaths: paths(manifest.exports) } };
    }),
    owners: read('topology/ownership.json').owners,
    rootPackages: templates['root-packages'],
    topology: read('topology/reference-topology.json'),
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
