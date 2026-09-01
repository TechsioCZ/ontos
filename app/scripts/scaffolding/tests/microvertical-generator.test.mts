import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planMicroverticalScaffold } from '../microvertical/scaffold.mts';
import { planModuleContractScaffold } from '../module-contract/scaffold.mts';
import { planActionBoundaryScaffold } from '../microvertical-action-boundary/scaffold.mts';

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ontos-microvertical-'));
  await mkdir(path.join(root, 'topology/local-overlays'), { recursive: true });
  await mkdir(path.join(root, 'apps/shell-super-app'), { recursive: true });
  await mkdir(path.join(root, 'verticals'), { recursive: true });
  await writeFile(
    path.join(root, 'topology/reference-topology.json'),
    JSON.stringify({
      shell: {
        verticalRefs: ['contacts'],
        moduleFederation: {
          remotes: [
            {
              id: 'contacts',
              name: 'verticalContacts',
              manifestUrl: 'http://localhost:4101/mf-manifest.json',
            },
          ],
        },
      },
      verticals: [
        {
          id: 'contacts',
          moduleFederation: { manifestUrl: 'http://localhost:4101/mf-manifest.json' },
        },
      ],
    }),
  );
  await writeFile(
    path.join(root, 'topology/local-overlays/development.json'),
    JSON.stringify({
      ports: { contacts: 4101 },
      manifests: { contacts: 'x' },
      ontosModuleManifests: { contacts: 'x' },
      apis: { contacts: 'x' },
      serverExecution: { contacts: {} },
    }),
  );
  await writeFile(path.join(root, 'topology/ownership.json'), JSON.stringify({ owners: [] }));
  await writeFile(
    path.join(root, 'apps/shell-super-app/package.json'),
    JSON.stringify({
      dependencies: { '@app/contacts': 'workspace:*' },
      'zephyr:dependencies': { contacts: '@app/contacts@workspace:*' },
    }),
  );
  await writeFile(
    path.join(root, 'apps/shell-super-app/tsconfig.json'),
    JSON.stringify({ references: [{ path: '../../verticals/contacts' }] }),
  );
  await writeFile(path.join(root, 'zerops.yaml'), "services:\n  - setup: 'shellsuperapp'\n");
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [] }));
  return root;
};

test('plans an empty reusable deployment without Contacts business artifacts', async () => {
  const root = await fixture();
  try {
    const plan = await planMicroverticalScaffold(root, { port: '4102', vertical: 'projects' });
    const topologyMutation = plan.mutations.find((item) =>
      item.path.endsWith('reference-topology.json'),
    );
    assert.ok(topologyMutation);
    const topology = JSON.parse(topologyMutation.content);
    const projects = topology.verticals.find((item: { id: string }) => item.id === 'projects');
    assert.deepEqual(projects.moduleFederation.exposes, []);
    assert.equal(projects.api.domainOperations, undefined);
    assert.equal(topology.shell.verticalRefs.at(-1), 'projects');
    assert.deepEqual(topology.shell.moduleFederation.remotes.at(-1), {
      id: 'projects',
      name: 'verticalProjects',
      manifestUrl: 'http://localhost:4102/mf-manifest.json',
    });
    const shellPackage = plan.mutations.find((item) =>
      item.path.endsWith('apps/shell-super-app/package.json'),
    );
    assert.equal(
      JSON.parse(shellPackage?.content ?? '{}').dependencies['@app/projects'],
      'workspace:*',
    );
    assert.equal(
      JSON.parse(shellPackage?.content ?? '{}')['zephyr:dependencies'].projects,
      '@app/projects@workspace:*',
    );
    const shellTsconfig = plan.mutations.find((item) =>
      item.path.endsWith('apps/shell-super-app/tsconfig.json'),
    );
    assert.deepEqual(JSON.parse(shellTsconfig?.content ?? '{}').references.at(-1), {
      path: '../../verticals/projects',
    });
    const mf = plan.mutations.find((item) => item.path.endsWith('module-federation.config.ts'));
    assert.match(mf?.content ?? '', /exposes: \{\}/u);
    const packageMutation = plan.mutations.find((item) =>
      item.path.endsWith('verticals/projects/package.json'),
    );
    assert.doesNotMatch(
      packageMutation?.content ?? '',
      /@app\/core-runtime|generate-ontos-module-contract/u,
    );
    assert.equal(new Set(plan.mutations.map((item) => item.path)).size, plan.mutations.length);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('feeds the module-contract and action-boundary generators', async () => {
  const root = await fixture();
  try {
    const base = await planMicroverticalScaffold(root, { port: '4102', vertical: 'projects' });
    for (const mutation of base.mutations) {
      await mkdir(path.dirname(mutation.path), { recursive: true });
      await writeFile(mutation.path, mutation.content);
    }
    await mkdir(path.join(root, 'verticals/stale-cache-only'), { recursive: true });
    const moduleContract = await planModuleContractScaffold(root, {
      module: 'projects.core',
      vertical: 'projects',
    });
    for (const mutation of moduleContract.mutations) {
      await mkdir(path.dirname(mutation.path), { recursive: true });
      await writeFile(mutation.path, mutation.content);
    }
    const boundary = await planActionBoundaryScaffold(root, { vertical: 'projects' });
    assert.ok(
      boundary.mutations.some((item) => item.path.endsWith('api/auth/action-principal.ts')),
    );
    assert.ok(boundary.mutations.some((item) => item.path.endsWith('src/api/action-gateway.ts')));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('rejects duplicate slug, duplicate port, invalid input, and malformed topology', async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      planMicroverticalScaffold(root, { port: '4102', vertical: '../projects' }),
      /lower-kebab-case/u,
    );
    await assert.rejects(
      planMicroverticalScaffold(root, { port: '4101', vertical: 'projects' }),
      /already assigned/u,
    );
    await assert.rejects(
      planMicroverticalScaffold(root, { port: '4102', vertical: 'contacts' }),
      /already exists/u,
    );
    await writeFile(path.join(root, 'topology/reference-topology.json'), '{broken');
    await assert.rejects(
      planMicroverticalScaffold(root, { port: '4102', vertical: 'projects' }),
      /invalid JSON/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
