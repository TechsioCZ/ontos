#!/usr/bin/env bash
# Hosted Ubuntu 24.04 supplies Node with native type stripping. Planning needs only authored JSON
# and the pure impact algorithm, never node_modules, code generation, mise or an installed compiler.
set -euo pipefail
node --input-type=module - "$@" <<'JS'
import { readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { integrationPhases, planCiChecks, unitPhases, withCiTopologyDependencies } from './scripts/ci-impact.mts';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const templates = read('scripts/ci-matrices.json');
const ownership = read('topology/ownership.json');
const topology = read('topology/reference-topology.json');
const directories = ['.', ...['apps', 'packages', 'verticals'].flatMap(area =>
  readdirSync(area).map(entry => `${area}/${entry}`).filter(directory => existsSync(`${directory}/package.json`)))];
const manifests = directories.map(directory => ({directory, manifest: read(`${directory}/package.json`)}));
const names = new Set(manifests.map(({manifest}) => manifest.name));
const groups = manifest => [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies];
const packages = withCiTopologyDependencies(manifests.map(({directory, manifest}) => ({
  contractProducer: manifest.ontosContractOwner?.packageName,
  dependencies: [...new Set(groups(manifest).flatMap(group => Object.entries(group ?? {}))
    .filter(([name, version]) => names.has(name) || name.startsWith('@app/') || version.startsWith('workspace:'))
    .map(([name]) => name))],
  directory,
  name: manifest.name,
  uncertain: (directory !== '.' && !ownership.owners.some(owner => owner.package === manifest.name && owner.path === directory)) ||
    groups(manifest).some(group => Object.values(group ?? {}).some(version => /^(?:file:|link:|workspace:(?:[./]|.*[:/]))/u.test(version))),
})), topology);
const plan = planCiChecks({
  changedPaths: readFileSync(process.argv[2], 'utf8').split('\0').filter(Boolean),
  forceFull: process.env.BOOTSTRAP_MODE === 'full',
  packages,
  templates,
});
const phases = integrationPhases(plan.integration);
const units = unitPhases(plan.unit);
appendFileSync(process.env.GITHUB_OUTPUT, Object.entries({
  mode: plan.mode, expected: JSON.stringify(plan.expected), source: JSON.stringify(plan.source.filter(row => row['typescript-build'] === true)),
  sourceExtra: JSON.stringify(plan.source.filter(row => row['typescript-build'] !== true)),
  unit: JSON.stringify(units.work),
  unitAfterStatic: JSON.stringify(units.afterStatic), integration: JSON.stringify(phases.work),
  unitAfterBrowser: JSON.stringify(units.afterBrowser),
  integrationAfterContracts: JSON.stringify(phases.afterContracts),
  integrationAfterTooling: JSON.stringify(phases.afterTooling),
  integrationSetup: JSON.stringify(phases.preparation),
  integrationTopology: JSON.stringify(phases.topology),
}).map(([key, value]) => `${key}=${value}\n`).join(''));
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI selection\n\n${plan.reason}\n\nAffected packages: ${plan.affectedPackages.join(', ')}\n`);
JS
