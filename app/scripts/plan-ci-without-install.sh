#!/usr/bin/env bash
# Hosted Ubuntu 24.04 supplies Node with native type stripping. Planning needs only authored JSON, the
# packages: globs of pnpm-workspace.yaml read as plain text, and the pure impact algorithm, never
# node_modules, code generation, mise or an installed compiler.
set -euo pipefail
node --input-type=module - "$@" <<'JS'
import { readFileSync, readdirSync, existsSync, appendFileSync, statSync } from 'node:fs';
import {
  ciPlanOutputs, ciWorkspacePackages, lintSweeps, planCiChecks, workspacePackageDirectories,
} from './scripts/ci-impact.mts';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const lintSweep = process.env.LINT_SWEEP;
if (!lintSweeps.includes(lintSweep)) {
  throw new Error(`LINT_SWEEP must be one of ${lintSweeps.join(', ')}`);
}
// A misspelt mode must never turn the full backstop into an affected run.
const bootstrapMode = process.env.BOOTSTRAP_MODE;
if (bootstrapMode !== 'affected' && bootstrapMode !== 'full') {
  throw new Error('BOOTSTRAP_MODE must be affected or full');
}
// A glob segment that lists a missing directory or a file matches nothing, as in the shell.
const workspace = workspacePackageDirectories(
  readFileSync('pnpm-workspace.yaml', 'utf8'),
  directory => existsSync(directory) && statSync(directory).isDirectory() ? readdirSync(directory) : [],
  directory => existsSync(`${directory}/package.json`),
);
if ('unreadable' in workspace) {
  throw new Error(workspace.unreadable);
}
const directories = ['.', ...[...workspace.directories].sort()];
const plan = planCiChecks({
  changedPaths: readFileSync(process.argv[2], 'utf8').split('\0').filter(Boolean),
  eventName: process.env.GITHUB_EVENT_NAME,
  forceFull: bootstrapMode === 'full',
  packages: ciWorkspacePackages({
    manifests: directories.map(directory => ({directory, manifest: read(`${directory}/package.json`)})),
    owners: read('topology/ownership.json').owners,
    topology: read('topology/reference-topology.json'),
  }),
  templates: read('scripts/ci-matrices.json'),
});
if ('invalid' in plan) {
  throw new Error(plan.invalid);
}
appendFileSync(process.env.GITHUB_OUTPUT, [
  `mode=${plan.mode}\n`,
  ...Object.entries(ciPlanOutputs(plan, lintSweep)).map(([key, value]) => `${key}=${JSON.stringify(value)}\n`),
].join(''));
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI selection\n\n${plan.reason}\n\nAffected packages: ${plan.affectedPackages.join(', ')}\n`);
JS
