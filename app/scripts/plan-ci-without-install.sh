#!/usr/bin/env bash
# Hosted Ubuntu 24.04 supplies Node with native type stripping. Planning needs only authored JSON
# and the pure impact algorithm, never node_modules, code generation, mise or an installed compiler.
set -euo pipefail
node --input-type=module - "$@" <<'JS'
import { readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { ciPlanOutputs, ciWorkspacePackages, lintSweeps, planCiChecks } from './scripts/ci-impact.mts';

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
const directories = ['.', ...['apps', 'packages', 'verticals'].flatMap(area =>
  readdirSync(area).map(entry => `${area}/${entry}`).filter(directory => existsSync(`${directory}/package.json`)))];
const plan = planCiChecks({
  changedPaths: readFileSync(process.argv[2], 'utf8').split('\0').filter(Boolean),
  forceFull: bootstrapMode === 'full',
  packages: ciWorkspacePackages({
    manifests: directories.map(directory => ({directory, manifest: read(`${directory}/package.json`)})),
    owners: read('topology/ownership.json').owners,
    topology: read('topology/reference-topology.json'),
  }),
  templates: read('scripts/ci-matrices.json'),
});
appendFileSync(process.env.GITHUB_OUTPUT, [
  `mode=${plan.mode}\n`,
  ...Object.entries(ciPlanOutputs(plan, lintSweep)).map(([key, value]) => `${key}=${JSON.stringify(value)}\n`),
].join(''));
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI selection\n\n${plan.reason}\n\nAffected packages: ${plan.affectedPackages.join(', ')}\n`);
JS
