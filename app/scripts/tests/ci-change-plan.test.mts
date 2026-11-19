import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Effect, Order, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CI_MATRICES_KEYS, knownTask, taskDirectory } from '../ci/ci-matrices-rules.mts';
import { CiTemplatesSchema, parseCiMatrices } from '../ci/ci-matrices.mts';
import {
  filterPaths,
  matchingPackages,
  planCiChecks,
  unknownFilters,
  withCiTopologyDependencies,
} from '../plan-ci-checks.mts';
import { workspaceConsumerClosure } from '../workspace-consumer-closure.mts';

/** The demo trunk's matrices: the shared file with the overlay its gates workflow names. */
const templates = Result.getOrThrow(
  parseCiMatrices(
    readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
    readFileSync(new URL('../ci-matrices.demo.json', import.meta.url), 'utf-8'),
  ),
);
const rootLevelPackageDirectories = templates['root-packages'] ?? [];
const appRoot = path.resolve(import.meta.dirname, '../..');
const PACKAGE_MANIFEST = 'package.json';
const ManifestFromJson = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }),
);
/** Every pnpm workspace member the planner can see, read from disk rather than restated here. */
const workspacePackages = [
  ...['apps', 'packages', 'verticals'].flatMap((area) =>
    readdirSync(path.join(appRoot, area), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(appRoot, area, entry.name, PACKAGE_MANIFEST)))
      .map((entry) => `${area}/${entry.name}`),
  ),
  ...rootLevelPackageDirectories,
].map((directory) => {
  const manifest = Schema.decodeUnknownSync(ManifestFromJson)(
    readFileSync(path.join(appRoot, directory, PACKAGE_MANIFEST), 'utf-8'),
  );
  return { dependencies: [], directory, name: manifest.name, scripts: manifest.scripts ?? {} };
});
const knownSelectors = new Set(['.', ...workspacePackages.map(({ directory }) => directory)]);
const CATALOG = '@app/catalog';
const PRICING = '@app/pricing';
const CATALOG_SOURCE = 'app/verticals/catalog/src/service.ts';
const ANOTHER_DIRECTORY = 'verticals/another';
const CUSTOMER_CONTEXT = '@app/commerce-customer-context';
const SHELL = '@app/shell-super-app';
const CATALOG_DIRECTORY = 'verticals/catalog';
const PRIVACY_DIRECTORY = 'verticals/privacy';
const PRIVACY = '@app/privacy';
const SHELL_DIRECTORY = 'apps/shell-super-app';
/** The task selector of the Shell's integration suite. */
const SHELL_TASK = `./${SHELL_DIRECTORY}`;
const PRICING_DIRECTORY = 'verticals/pricing';
const owners = [
  // The fixture's changed catalog file is one its exports map names: other packages consume it.
  { dependencies: [], directory: CATALOG_DIRECTORY, exportTargets: ['src/service.ts'], name: CATALOG },
  { dependencies: [CATALOG], directory: PRICING_DIRECTORY, name: PRICING },
  { dependencies: [], directory: PRIVACY_DIRECTORY, name: PRIVACY },
  { dependencies: [], directory: SHELL_DIRECTORY, name: SHELL },
  { dependencies: [], directory: 'verticals/party-registry', name: '@app/party-registry' },
  { dependencies: [], directory: 'verticals/commerce-cart', name: '@app/commerce-cart' },
  { dependencies: [], directory: 'verticals/storefront-registry', name: '@app/storefront-registry' },
  { dependencies: [], directory: 'verticals/commerce-market-catalog', name: '@app/commerce-market-catalog' },
  { dependencies: [], directory: 'verticals/commerce-customer-context', name: CUSTOMER_CONTEXT },
];
/** The owners above plus every other directory a template task runs in: each task names a package, as on this trunk. */
const packages = [
  ...owners,
  ...[
    ...new Set(templates.integration.flatMap(({ tasks }) => tasks ?? []).flatMap((task) => taskDirectory(task) ?? [])),
  ]
    .filter((directory) => !owners.some((owner) => owner.directory === directory))
    .map((directory) => ({ dependencies: [], directory, name: `@app/${path.basename(directory)}` })),
];
/** The workspace directories whose integration files a row's tasks run. */
const taskDirectories = (row: { readonly tasks?: readonly string[] | undefined }) => [
  ...new Set((row.tasks ?? []).flatMap((task) => taskDirectory(task) ?? [])),
];
/** Every task an integration matrix runs, sorted. */
const allTasks = (entries: readonly { readonly tasks?: readonly string[] | undefined }[]) =>
  EffectArray.sort(
    entries.flatMap((entry) => entry.tasks ?? []),
    Order.String,
  );
const preproposalRow = (entry: { readonly tasks?: readonly string[] | undefined }) =>
  (entry.tasks ?? []).some((task) => task.startsWith('whole:preproposal-'));

it('selects owner and transitive consumer tests without selecting an unrelated owner', () => {
  const plan = planCiChecks({
    applyAffected: true,
    changedPaths: [CATALOG_SOURCE],
    packages,
    templates,
  });
  expect(plan.mode).toBe('affected');
  expect(plan.affectedPackages).toEqual([CATALOG, PRICING]);
  // The bootstrap row stays; ordinary package tasks are restricted to the affected owner and its consumers.
  expect(plan.integration.some(({ suite }) => suite === 'bootstrap')).toBe(true);
  const ordinaryTasks = allTasks(plan.integration).filter((task) => task.startsWith('./'));
  expect(ordinaryTasks.length).toBeGreaterThan(0);
  expect(
    ordinaryTasks.every((task) => task.startsWith('./verticals/catalog#') || task.startsWith('./verticals/pricing#')),
  ).toBe(true);
  expect(
    EffectArray.sort(
      [...new Set(plan.integration.filter(({ suite }) => suite === 'integration').flatMap(taskDirectories))],
      Order.String,
    ),
  ).toEqual([CATALOG_DIRECTORY, PRICING_DIRECTORY]);
  expect(plan.integration.filter(preproposalRow)).toHaveLength(2);
  expect(plan.unit.flatMap(({ commands }) => commands.split('\n'))).toContain(
    'pnpm -r --no-sort --if-present --filter ./verticals/catalog run test:unit',
  );
});

it('narrows only the package list of a unit row and keeps its authored commands and flags', () => {
  const row = {
    commands: [
      'pnpm -r --no-sort --workspace-concurrency=2 --if-present --filter ./verticals/catalog --filter ./verticals/privacy run test:unit --pool.maxWorkers 2',
      "pnpm -r --no-sort --if-present --filter './verticals/catalog' --filter './verticals/privacy' run test:component",
      '',
    ].join('\n'),
    name: 'Unit and Component Tests (Catalog and Privacy)',
  };
  const plan = planCiChecks({
    applyAffected: true,
    changedPaths: ['app/verticals/privacy/src/internal.ts'],
    packages,
    templates: { ...templates, unit: [row] },
  });
  expect(plan.mode).toBe('affected');
  expect(plan.unit.map(({ commands }) => commands)).toEqual([
    [
      'pnpm -r --no-sort --workspace-concurrency=2 --if-present --filter ./verticals/privacy run test:unit --pool.maxWorkers 2',
      'pnpm -r --no-sort --if-present --filter ./verticals/privacy run test:component',
      '',
    ].join('\n'),
  ]);
});

const FINANCE_BILLING = '@app/finance-billing';
const FINANCE_DIRECTORY = 'verticals/finance-billing';
const FACILITY_OPERATIONS = '@app/facility-operations';
const narrowPackages = [
  ...packages.filter(({ name }) => ![SHELL, FINANCE_BILLING, FACILITY_OPERATIONS].includes(name)),
  {
    dependencies: [],
    directory: FINANCE_DIRECTORY,
    exportTargets: ['src/worker-host/entry.ts'],
    name: FINANCE_BILLING,
  },
  { dependencies: [FINANCE_BILLING], directory: 'verticals/facility-operations', name: FACILITY_OPERATIONS },
  // The Shell and the root suites consume every vertical.
  {
    dependencies: [CATALOG, FINANCE_BILLING, FACILITY_OPERATIONS],
    directory: SHELL_DIRECTORY,
    name: SHELL,
  },
  { dependencies: [SHELL], directory: '.', name: 'app' },
];
const narrowPlan = (changedPath: string) =>
  planCiChecks({ applyAffected: true, changedPaths: [changedPath], packages: narrowPackages, templates });
const SHELL_OR_ROOT = (entry: { readonly tasks?: readonly string[] | undefined }) =>
  (entry.tasks ?? []).some((task) => task.startsWith(SHELL_TASK) || task.startsWith('root:'));

/** A task that runs root integration files, sharded or whole. */
const rootWork = (task: string) =>
  task.startsWith('root:') ||
  ['whole:customer-readback', 'whole:customer-roundtrip', 'whole:pricing-routes'].includes(task);
/** A shard of the Shell's integration suite. */
const shellShard = (task: string) => task.startsWith(`${SHELL_TASK}#`);
/** A shard of Customer Context's integration suite. */
const customerContext = (task: string) => task.startsWith('./verticals/commerce-customer-context#');

it('narrows a change inside one vertical to its own rows and the source gates', () => {
  const plan = narrowPlan(`app/${FINANCE_DIRECTORY}/src/services/invoice-totals.ts`);
  expect(plan.mode).toBe('affected');
  expect(plan.affectedPackages).toEqual([FINANCE_BILLING]);
  const ordinary = plan.integration.filter(({ suite }) => suite === 'integration');
  expect(allTasks(ordinary).filter((task) => task.startsWith('./'))).toEqual([`./${FINANCE_DIRECTORY}`]);
  // Neither the Shell nor a root suite consumes a vertical's internals; only its public surface.
  expect(ordinary.some(SHELL_OR_ROOT)).toBe(false);
  expect(plan.integration.some(({ suite }) => suite === 'browser')).toBe(false);
  // The deployment bootstrap reads no matrix input, so every plan with integration work keeps it.
  expect(plan.integration.filter(({ suite }) => suite === 'bootstrap')).toHaveLength(1);
  expect(plan.source).toEqual(templates.source);
  expect(plan.unit.map(({ name }) => name)).toEqual(['Unit and Component Tests (every other package)']);
  // Its tests are its own as well.
  expect(narrowPlan(`app/${FINANCE_DIRECTORY}/tests/unit/totals.test.ts`).affectedPackages).toEqual([FINANCE_BILLING]);
});

it('selects every consumer when a change reaches a vertical public surface, and widens what is shared', () => {
  // A file its exports map names, its runtime declaration and its locales are consumed: the Shell and root follow.
  for (const surface of ['src/worker-host/entry.ts', 'vertical.runtime-declaration.ts', 'locales/cs/finance.json']) {
    const plan = narrowPlan(`app/${FINANCE_DIRECTORY}/${surface}`);
    expect(plan.mode, surface).toBe('affected');
    expect(plan.affectedPackages, surface).toEqual(
      expect.arrayContaining([FINANCE_BILLING, FACILITY_OPERATIONS, SHELL, 'app']),
    );
    expect(plan.integration.some(SHELL_OR_ROOT), surface).toBe(true);
  }
  // Shared code, the manifest, the registration, migrations and core packages run the complete suite.
  for (const changedPath of [
    `app/${FINANCE_DIRECTORY}/shared/domain/invoice.ts`,
    `app/${FINANCE_DIRECTORY}/vertical.manifest.ts`,
    `app/${FINANCE_DIRECTORY}/vertical.registration.ts`,
    `app/${FINANCE_DIRECTORY}/drizzle/0001_invoice.sql`,
    'app/packages/core-runtime/src/actions/runtime.ts',
  ]) {
    expect(narrowPlan(changedPath).mode, changedPath).toBe('full');
  }
});

it('selects the Shell rows and the browser checks for a change inside the Shell', () => {
  const plan = narrowPlan(`app/${SHELL_DIRECTORY}/src/routes/home.tsx`);
  expect(plan.mode).toBe('affected');
  expect(plan.affectedPackages).toEqual([SHELL]);
  const shellTasks = templates.integration
    .flatMap((entry) => entry.tasks ?? [])
    .filter((task) => task.startsWith(SHELL_TASK));
  expect(shellTasks.length).toBeGreaterThan(1);
  expect(allTasks(plan.integration).filter((task) => task.startsWith(SHELL_TASK))).toEqual(
    EffectArray.sort(shellTasks, Order.String),
  );
  expect(plan.integration.some(({ suite }) => suite === 'browser')).toBe(true);
  expect(allTasks(plan.integration).some((task) => task.startsWith('root:'))).toBe(false);
});

it('retains the native preproposal proof for each runtime owner even without ordinary package matches', () => {
  const native = templates.integration.find(preproposalRow);
  expect(native?.['proof-packages']).toHaveLength(8);
  for (const owner of native?.['proof-packages'] ?? []) {
    const workspacePackage = packages.find(({ name }) => name === owner);
    const plan = planCiChecks({
      applyAffected: true,
      changedPaths: [`app/${workspacePackage?.directory ?? 'missing'}/src/service.ts`],
      packages,
      templates,
    });
    expect(plan.mode).toBe('affected');
    expect(plan.integration.filter(preproposalRow)).toHaveLength(2);
    if (owner === PRICING) {
      expect(plan.affectedPackages).toEqual([PRICING]);
      for (const row of plan.integration.filter(preproposalRow)) {
        // Only the proof itself and the affected owner's own files remain; no root file rides along.
        expect(taskDirectories(row).every((directory) => directory === PRICING_DIRECTORY)).toBe(true);
        expect((row.tasks ?? []).some((task) => task.startsWith('root:'))).toBe(false);
      }
    }
  }
});

it('omits the native preproposal proof for an unrelated owner and widens unknown proof dependencies', () => {
  const plan = (entries: typeof packages) =>
    planCiChecks({
      applyAffected: true,
      changedPaths: ['app/verticals/privacy/src/service.ts'],
      packages: entries,
      templates,
    });
  expect(plan(packages).mode).toBe('affected');
  expect(
    plan(packages)
      .integration.flatMap((entry) => entry.tasks ?? [])
      .some((task) => task.startsWith('whole:preproposal-')),
  ).toBe(false);
  expect(plan(packages.filter(({ name }) => name !== PRICING)).mode).toBe('full');
  expect(
    Schema.is(CiTemplatesSchema)({
      ...templates,
      integration: templates.integration.map((entry) => ({ ...entry, 'proof-packages': [] })),
    }),
  ).toBe(false);
});

it('gives each matrix job only its own rows and plans a job without rows as skipped', () => {
  const full = planCiChecks({ applyAffected: false, changedPaths: [CATALOG_SOURCE], packages, templates });
  expect(full.jobs.browser.map(({ suite }) => suite)).toEqual(['browser']);
  expect(full.jobs.topology.map(({ suite }) => suite)).toEqual(['bootstrap']);
  expect(full.jobs.owners.every(({ suite }) => suite === 'integration')).toBe(true);
  expect(full.jobs.owners.length + full.jobs.browser.length + full.jobs.topology.length).toBe(
    templates.integration.length,
  );
  // One database producer prepares the run's database for every owner row; no owner row migrates its own.
  expect(full.jobs.database).toEqual([{ name: 'Prepare integration database', suite: 'database' }]);
  expect(templates.integration.some(({ suite }) => suite === 'database')).toBe(false);
  expect(full.jobs.unitArtifacts.every((entry) => entry['node-artifacts'] === true)).toBe(true);
  expect(full.jobs.unitPlain.some((entry) => entry['node-artifacts'] === true)).toBe(false);
  expect(full.jobs.unitArtifacts.length + full.jobs.unitPlain.length).toBe(templates.unit.length);
  expect(Object.values(full.expected).every((result) => result === 'success')).toBe(true);
  const affected = planCiChecks({ applyAffected: true, changedPaths: [CATALOG_SOURCE], packages, templates });
  // Catalog and Pricing unit rows read built outputs, and no browser row consumes them.
  expect(affected.expected['workspace-unit-artifacts']).toBe('success');
  expect(affected.jobs.browser).toEqual([]);
  expect(affected.expected['node-artifact-build']).toBe('success');
  // The database producer and the bootstrap row run whenever integration work does, also on an affected round.
  expect(affected.expected['service-integration']).toBe('success');
  expect(affected.jobs.database).toHaveLength(1);
  expect(affected.jobs.topology).toHaveLength(1);
  expect(affected.jobs.owners.flatMap((row) => row.tasks ?? [])).toContain('./verticals/catalog#1/4');
  // The gates the plan names are exactly the ones app/scripts/check-ci-gates.sh requires.
  expect(Object.keys(affected.expected).toSorted()).toEqual([
    'format-and-lint',
    'node-artifact-build',
    'service-integration',
    'static-contracts',
    'workspace-gate',
    'workspace-unit',
    'workspace-unit-artifacts',
  ]);
  // A sharded single-package row whose package is affected runs exactly as planned.
  const shell = planCiChecks({
    applyAffected: true,
    changedPaths: ['app/apps/shell-super-app/src/service.ts'],
    packages,
    templates,
  });
  expect(shell.unit.filter(({ name }) => name.startsWith('Unit Tests (Shell')).map(({ commands }) => commands)).toEqual(
    templates.unit.filter(({ name }) => name.startsWith('Unit Tests (Shell')).map(({ commands }) => commands),
  );
});

it('keeps affected selection in shadow mode until explicitly enabled', () => {
  const plan = planCiChecks({
    applyAffected: false,
    changedPaths: [CATALOG_SOURCE],
    packages,
    templates,
  });
  expect(plan.mode).toBe('full');
  expect(plan.integration).toEqual(templates.integration);
  expect(plan.expected).not.toHaveProperty('cloudflare-artifact-build');
  expect(plan.affectedPackages).toEqual([CATALOG, PRICING]);
});

it('keeps mixed documentation and owner changes scoped, but widens a mixed unknown owner', () => {
  expect(
    planCiChecks({
      applyAffected: true,
      changedPaths: ['README.md', CATALOG_SOURCE],
      packages,
      templates,
    }).mode,
  ).toBe('affected');
  expect(
    planCiChecks({
      applyAffected: true,
      changedPaths: ['app/verticals/missing/src/service.ts', CATALOG_SOURCE],
      packages,
      templates,
    }).mode,
  ).toBe('full');
});

it('widens broken dependency metadata rather than silently dropping its consumers', () => {
  for (const extra of [
    { dependencies: ['@app/missing'], directory: ANOTHER_DIRECTORY, name: '@app/another' },
    { dependencies: [], directory: ANOTHER_DIRECTORY, name: CATALOG },
    { dependencies: [], directory: ANOTHER_DIRECTORY, name: '@app/another', uncertain: true },
  ]) {
    expect(
      planCiChecks({
        applyAffected: true,
        changedPaths: [CATALOG_SOURCE],
        packages: [...packages, extra],
        templates,
      }).mode,
    ).toBe('full');
  }
});

it('rejects incomplete full matrices and widens an unrunnable task form', () => {
  expect(
    Schema.is(CiTemplatesSchema)({
      ...templates,
      integration: [{ name: 'Missing task list', suite: 'integration' }],
    }),
  ).toBe(false);
  expect(
    Schema.is(CiTemplatesSchema)({
      ...templates,
      integration: [{ name: 'Unrunnable task', suite: 'integration', tasks: ['@app/pricing...'] }],
    }),
  ).toBe(false);
  // A runnable form naming a directory that is no workspace package widens too, instead of matching nothing.
  for (const task of [
    '@app/pricing...',
    './verticals/catalog#one',
    'whole:invented',
    './sites/missing#1/2',
    './verticals/missing',
  ]) {
    expect(
      planCiChecks({
        applyAffected: true,
        changedPaths: [CATALOG_SOURCE],
        packages,
        templates: { ...templates, integration: [{ name: 'Unproven task', suite: 'integration', tasks: [task] }] },
      }).mode,
      task,
    ).toBe('full');
  }
});

it('keeps the bootstrap row in every affected plan and prepares no database that no owner row restores', () => {
  const proof = { name: 'Node Artifact Proof', suite: 'bootstrap' } as const;
  expect(Schema.is(CiTemplatesSchema)({ ...templates, integration: [proof] })).toBe(true);
  const alone = planCiChecks({
    applyAffected: true,
    changedPaths: [CATALOG_SOURCE],
    packages,
    templates: { ...templates, integration: [proof] },
  });
  expect(alone.mode).toBe('affected');
  expect(alone.integration).toEqual([proof]);
  // The bootstrap row migrates its own cluster; the database producer only serves owner rows.
  expect(alone.expected['service-integration']).toBe('skipped');
});

it('selects extracted root conformance tasks only with root impact, on their original rows', () => {
  const rootConformance = ['whole:customer-readback', 'whole:customer-roundtrip', 'whole:pricing-routes'];
  const assignments = (entries: typeof templates.integration) =>
    entries.flatMap((entry) =>
      (entry.tasks ?? []).filter((task) => rootConformance.includes(task)).map((task) => ({ name: entry.name, task })),
    );
  for (const rootAffected of [false, true]) {
    const plan = planCiChecks({
      applyAffected: true,
      changedPaths: [CATALOG_SOURCE],
      packages: [...packages, { dependencies: rootAffected ? [CATALOG] : [], directory: '.', name: 'app' }],
      templates,
    });
    expect(plan.mode).toBe('affected');
    expect(plan.affectedPackages.includes('app')).toBe(rootAffected);
    expect(assignments(plan.integration)).toEqual(rootAffected ? assignments(templates.integration) : []);
  }
  expect(assignments(templates.integration)).toHaveLength(rootConformance.length);
});

it('does not start an integration row after its selected tasks move to another row', () => {
  for (const owner of workspacePackages) {
    const plan = planCiChecks({
      applyAffected: true,
      changedPaths: [`app/${owner.directory}/src/service.ts`],
      packages: workspacePackages,
      templates,
    });
    for (const row of plan.integration) {
      if (row.tasks !== undefined) {
        expect(row.tasks.length, `${owner.name}: ${row.name}`).toBeGreaterThan(0);
      }
    }
    const owns = (task: string) => task === `./${owner.directory}` || task.startsWith(`./${owner.directory}#`);
    const expected = templates.integration.flatMap((row) => row.tasks ?? []).filter(owns);
    const selected = plan.integration.flatMap((row) => row.tasks ?? []).filter(owns);
    expect(EffectArray.sort(selected, Order.String), owner.name).toEqual(EffectArray.sort(expected, Order.String));
  }
});

it('selects browser checks, all root integration shards and every Shell shard when they consume a changed package', () => {
  const plan = planCiChecks({
    applyAffected: true,
    changedPaths: [CATALOG_SOURCE],
    packages: [
      ...packages.map((entry) => (entry.name === SHELL ? { ...entry, dependencies: [CATALOG] } : entry)),
      { dependencies: [CATALOG], directory: '.', name: 'app' },
    ],
    templates,
  });
  expect(plan.integration.some(({ suite }) => suite === 'browser')).toBe(true);
  // Every root file runs, including those listed in rows that hold no other root work.
  expect(allTasks(plan.integration).filter(rootWork)).toEqual(allTasks(templates.integration).filter(rootWork));
  // And every Shell shard, in the rows that hold them.
  expect(allTasks(plan.integration).filter(shellShard)).toEqual(allTasks(templates.integration).filter(shellShard));
  const directories = new Set(plan.integration.flatMap(taskDirectories));
  expect(directories.has(SHELL_DIRECTORY)).toBe(true);
  expect(directories.has(CATALOG_DIRECTORY)).toBe(true);
});

it('follows topology-only Shell and vertical remote references to browser tests', () => {
  const verticals = [
    { id: 'catalog', package: CATALOG, path: CATALOG_DIRECTORY },
    { id: 'pricing', package: PRICING, path: 'verticals/pricing' },
    { id: 'privacy', package: PRIVACY, path: PRIVACY_DIRECTORY },
  ];
  const shell = { id: 'shell-super-app', package: SHELL, path: SHELL_DIRECTORY };
  for (const references of [
    { verticalRefs: ['catalog'] },
    { moduleFederation: { remotes: [{ id: 'catalog' }] } },
    { moduleFederation: { verticalRefs: ['catalog'] } },
  ]) {
    const graph = withCiTopologyDependencies(packages, { shell: { ...shell, ...references }, verticals });
    const plan = (changedPath: string) =>
      planCiChecks({ applyAffected: true, changedPaths: [changedPath], packages: graph, templates });
    expect(plan(CATALOG_SOURCE).mode).toBe('affected');
    expect(plan(CATALOG_SOURCE).affectedPackages).toContain(SHELL);
    expect(plan(CATALOG_SOURCE).integration.some(({ suite }) => suite === 'browser')).toBe(true);
    expect(plan('app/verticals/privacy/src/service.ts').integration.some(({ suite }) => suite === 'browser')).toBe(
      false,
    );
  }
  const graph = withCiTopologyDependencies(packages, {
    shell: { ...shell, verticalRefs: ['privacy'] },
    verticals: [
      ...verticals.slice(0, 2),
      {
        id: 'privacy',
        moduleFederation: { remotes: [{ id: 'catalog' }] },
        package: PRIVACY,
        path: PRIVACY_DIRECTORY,
      },
    ],
  });
  expect(workspaceConsumerClosure(graph, [CATALOG])).toContain(SHELL);
});

it('widens unknown, duplicate or mismatched topology relationships to the complete suite', () => {
  const shell = { id: 'shell-super-app', package: SHELL, path: SHELL_DIRECTORY, verticalRefs: ['catalog'] };
  const catalog = { id: 'catalog', package: CATALOG, path: CATALOG_DIRECTORY };
  for (const topology of [
    { shell: { ...shell, verticalRefs: ['missing'] }, verticals: [catalog] },
    { shell, verticals: [catalog, catalog] },
    { shell, verticals: [{ ...catalog, path: 'verticals/missing' }] },
    { shell: { ...shell, package: '@app/missing' }, verticals: [catalog] },
  ]) {
    expect(
      planCiChecks({
        applyAffected: true,
        changedPaths: [CATALOG_SOURCE],
        packages: withCiTopologyDependencies(packages, topology),
        templates,
      }).mode,
    ).toBe('full');
  }
});

it('uses every customer-context shard and its native proof for any selected customer-context package change', () => {
  const plan = planCiChecks({
    applyAffected: true,
    changedPaths: ['app/verticals/commerce-customer-context/src/service.ts'],
    packages,
    templates,
  });
  const shards = allTasks(templates.integration).filter(customerContext);
  expect(shards.length).toBeGreaterThan(1);
  expect(allTasks(plan.integration).filter(customerContext)).toEqual(shards);
  expect(plan.integration.filter(preproposalRow)).toHaveLength(2);
});

it('widens changed shared infrastructure, unknown paths and package metadata to the complete suite', () => {
  for (const changedPath of [
    'app/packages/core-runtime/src/service.ts',
    'app/verticals/new-owner/src/service.ts',
    'app/verticals/catalog/package.json',
    'app/verticals/catalog/drizzle/0001.sql',
    'app/verticals/catalog/src/database/schema.ts',
    'app/verticals/catalog/src/permissions/owner.ts',
    'app/docs/architecture/DEPLOYMENT.md',
    '.github/workflows/ultramodern-workspace-gates.yml',
    'app/pnpm-lock.yaml',
  ]) {
    expect(planCiChecks({ applyAffected: true, changedPaths: [changedPath], packages, templates }).mode).toBe('full');
  }
});

it('follows contract producers and terminates on dependency cycles', () => {
  expect(
    workspaceConsumerClosure(
      [
        { contractProducer: 'owner', dependencies: [], name: 'contract' },
        { dependencies: ['consumer'], name: 'owner' },
        { dependencies: ['contract'], name: 'consumer' },
        { dependencies: [], name: 'unrelated' },
      ],
      ['contract'],
    ),
  ).toEqual(new Set(['consumer', 'contract', 'owner']));
});

it.live('uses the exact Git comparison for documentation and refuses mixed, unavailable and manual shortcuts', () =>
  Effect.sync(() => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-ci-diff-'));
    const script = fileURLToPath(new URL('../plan-ci-changes.sh', import.meta.url));
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', ...args], {
        cwd: directory,
        encoding: 'utf-8',
      }).trim();
    try {
      git('init', '--quiet');
      writeFileSync(path.join(directory, 'README.md'), 'before\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(path.join(directory, 'README.md'), 'after\n');
      git('commit', '--quiet', '-am', 'docs');
      const run = (event: string, comparison = base, force = 'false', candidate = 'false') => {
        const output = path.join(directory, 'outputs');
        writeFileSync(output, '');
        execFileSync('/bin/bash', [script, path.join(directory, 'paths')], {
          cwd: directory,
          env: {
            BASE_SHA: comparison,
            CANDIDATE_DISPATCH: candidate,
            FORCE_FULL: force,
            GITHUB_EVENT_NAME: event,
            GITHUB_OUTPUT: output,
            HEAD_SHA: git('rev-parse', 'HEAD'),
            PATH: '/usr/bin:/bin',
          },
          stdio: 'pipe',
        });
        return readFileSync(output, 'utf-8');
      };
      const documentationPlan = run('merge_group');
      expect(documentationPlan).toContain('mode=docs\n');
      expect(documentationPlan).not.toContain('cloudflare-artifact-build');
      expect(run('push')).toContain('mode=docs\n');
      expect(run('workflow_dispatch')).toContain('mode=full\n');
      // A candidate dispatch with a resolved comparison point is classified like a pull request, unless forced full.
      expect(run('workflow_dispatch', base, 'false', 'true')).toContain('mode=docs\n');
      expect(run('workflow_dispatch', base, 'true', 'true')).toContain('mode=full\n');
      expect(run('workflow_dispatch', '0'.repeat(40), 'false', 'true')).toContain('mode=full\n');
      expect(run('pull_request', '0'.repeat(40))).toContain('mode=full\n');
      expect(run('pull_request', base, 'true')).toContain('mode=full\n');
      // A pull request run that is not on GitHub's merge commit has no merge parent to compare with.
      expect(run('pull_request')).toContain('mode=full\n');
      git('mv', 'README.md', 'runtime.ts');
      git('commit', '--quiet', '-m', 'rename into application input');
      expect(run('merge_group')).toContain('mode=affected\n');
      // The base moved on after the fork point. The pull request's merge commit compares with its first
      // parent, so only the pull request's own documentation counts, never the base's newer changes.
      const trunk = git('rev-parse', '--abbrev-ref', 'HEAD');
      git('checkout', '--quiet', '-b', 'documentation', base);
      mkdirSync(path.join(directory, 'docs'), { recursive: true });
      writeFileSync(path.join(directory, 'docs/guide.md'), 'guide\n');
      git('add', 'docs/guide.md');
      git('commit', '--quiet', '-m', 'guide');
      git('checkout', '--quiet', trunk);
      git('merge', '--quiet', '--no-ff', '-m', 'Merge documentation', 'documentation');
      expect(run('pull_request', base)).toContain('mode=docs\n');
      expect(readFileSync(path.join(directory, 'paths'), 'utf-8')).toBe('docs/guide.md\0');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);

/** The workflow id and run id of the recorded push run that plans; the lookup reads only this workflow. */
const PUSH_WORKFLOW_ID = 342_952_200;
const PUSH_RUN_ID = 44_400_000_000;
/** A branch name that would end the query parameter early if pasted into the URL. */
const PUSH_BRANCH = 'release/fix&docs';
const RUN_LOOKUP = `api repos/TechsioCZ/ontos/actions/runs/${PUSH_RUN_ID} --jq .workflow_id`;
const RUNS_LIST = `api --method GET repos/TechsioCZ/ontos/actions/workflows/${PUSH_WORKFLOW_ID}/runs -f branch=${PUSH_BRANCH} -f event=push -f per_page=100`;
/** One recorded workflow run as the list endpoint returns it, newest first; only the fields the lookup reads. */
interface RecordedRun {
  readonly conclusion: string | null;
  readonly created_at?: string;
  readonly event: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly status: string;
  readonly workflow_id?: number;
}
const recordedRuns = (runs: readonly RecordedRun[]) =>
  JSON.stringify({
    total_count: runs.length,
    workflow_runs: runs.map((run, index) => ({
      created_at: new Date(Date.UTC(2026, 10, 18, 12) - index * 60_000).toISOString().replace('.000', ''),
      id: PUSH_RUN_ID - index - 1,
      workflow_id: PUSH_WORKFLOW_ID,
      ...run,
    })),
  });
const greenPush = (sha: string): RecordedRun => ({
  conclusion: 'success',
  event: 'push',
  head_branch: PUSH_BRANCH,
  head_sha: sha,
  status: 'completed',
});
/** The recorded answers of a lookup that reads this run's workflow and then lists its push runs on the branch. */
const listed = (runs: readonly RecordedRun[]) => ({
  [RUN_LOOKUP]: { stdout: `${PUSH_WORKFLOW_ID}\n` },
  [RUNS_LIST]: { stdout: recordedRuns(runs) },
});

it.live('compares a push without a merge queue with its newest green push, and runs everything without one', () =>
  Effect.sync(() => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-ci-push-base-'));
    const repository = path.join(directory, 'repository');
    const script = fileURLToPath(new URL('../plan-ci-changes.sh', import.meta.url));
    mkdirSync(repository);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', ...args], {
        cwd: repository,
        encoding: 'utf-8',
      }).trim();
    const commit = (file: string) => {
      writeFileSync(path.join(repository, file), `${file}\n`);
      git('add', file);
      git('commit', '--quiet', '-m', file);
      return git('rev-parse', 'HEAD');
    };
    /** Plans HEAD with a fake gh that answers each recorded invocation exactly and fails every other one. */
    const plan = (
      routes: Readonly<Record<string, { readonly exit?: number; readonly stderr?: string; readonly stdout?: string }>>,
      environment: Readonly<Record<string, string>> = {},
    ) => {
      const bin = path.join(directory, 'bin');
      rmSync(bin, { force: true, recursive: true });
      mkdirSync(bin);
      const calls = path.join(directory, 'calls');
      const output = path.join(directory, 'outputs');
      writeFileSync(calls, '');
      writeFileSync(output, '');
      const branches = Object.entries(routes).map(([args, { exit = 0, stderr = '', stdout = '' }], index) => {
        writeFileSync(path.join(bin, `stdout-${index}`), stdout);
        writeFileSync(path.join(bin, `stderr-${index}`), stderr);
        return `  '${args}') cat '${bin}/stdout-${index}'; cat '${bin}/stderr-${index}' >&2; exit ${exit} ;;`;
      });
      writeFileSync(
        path.join(bin, 'gh'),
        [
          '#!/bin/bash',
          `printf '%s\\n' "$*" >> '${calls}'`,
          'case "$*" in',
          ...branches,
          '  *) echo "unexpected gh $*" >&2; exit 97 ;;',
          'esac',
          '',
        ].join('\n'),
      );
      chmodSync(path.join(bin, 'gh'), 0o755);
      const log = execFileSync('/bin/bash', [script, path.join(directory, 'paths')], {
        cwd: repository,
        encoding: 'utf-8',
        env: {
          BASE_SHA: git('rev-parse', 'HEAD~1'),
          GITHUB_EVENT_NAME: 'push',
          GITHUB_OUTPUT: output,
          GITHUB_REF_NAME: PUSH_BRANCH,
          GITHUB_REPOSITORY: 'TechsioCZ/ontos',
          GITHUB_RUN_ID: String(PUSH_RUN_ID),
          HEAD_SHA: git('rev-parse', 'HEAD'),
          NEWEST_GREEN_BASE: 'true',
          PATH: `${bin}:/usr/bin:/bin`,
          ...environment,
        },
        stdio: 'pipe',
      });
      return {
        calls: readFileSync(calls, 'utf-8').split('\n').filter(Boolean),
        log,
        mode: /^mode=(?<mode>\w+)$/mu.exec(readFileSync(output, 'utf-8'))?.groups?.mode,
        paths: readFileSync(path.join(directory, 'paths'), 'utf-8').split('\0').filter(Boolean),
      };
    };
    try {
      git('init', '--quiet');
      const green = commit('green.ts');
      git('checkout', '--quiet', '-b', 'sibling');
      const sibling = commit('sibling.ts');
      git('checkout', '--quiet', '-');
      const red = commit('red.ts');
      const cancelled = commit('cancelled.ts');
      commit('pushed.ts');
      const head = git('rev-parse', 'HEAD');
      const absent = 'f'.repeat(40);
      const unproven = ['cancelled.ts', 'pushed.ts', 'red.ts'];

      // (b) Only a completed, successful push run of this workflow on this branch proves a commit. Every newer run
      // here is something else: a run of this very commit, live, red, cancelled, of another event, branch or
      // workflow file. The diff therefore covers the red and cancelled pushes, not only this push's own commit.
      const mixed = plan(
        listed([
          { ...greenPush(head), conclusion: null, status: 'in_progress' },
          greenPush(head),
          { ...greenPush(cancelled), conclusion: 'cancelled' },
          { ...greenPush(cancelled), event: 'pull_request' },
          { ...greenPush(cancelled), event: 'merge_group' },
          { ...greenPush(cancelled), event: 'schedule' },
          { ...greenPush(cancelled), event: 'workflow_dispatch' },
          { ...greenPush(cancelled), head_branch: 'main' },
          { ...greenPush(cancelled), workflow_id: PUSH_WORKFLOW_ID + 1 },
          { ...greenPush(red), conclusion: 'failure' },
          { ...greenPush(red), conclusion: null, status: 'queued' },
          greenPush(green),
        ]),
      );
      expect(mixed.calls).toEqual([RUN_LOOKUP, RUNS_LIST]);
      expect(mixed.mode).toBe('affected');
      expect(mixed.paths).toEqual(unproven);
      expect(mixed.log).toContain(`Comparing with ${green},`);

      // Of two eligible green pushes the newer one by creation time is the base, whatever order the list has.
      const newest = plan(
        listed([
          { ...greenPush(green), created_at: '2026-11-18T11:00:00Z' },
          { ...greenPush(cancelled), created_at: '2026-11-18T12:00:00Z' },
        ]),
      );
      expect(newest.log).toContain(`Comparing with ${cancelled},`);
      expect(newest.paths).toEqual(['pushed.ts']);

      // (c) A green commit that is no ancestor of this push, or absent from the checkout, is passed over.
      const passedOver = plan(listed([greenPush(sibling), greenPush(absent), greenPush(green)]));
      expect(passedOver.mode).toBe('affected');
      expect(passedOver.paths).toEqual(unproven);
      for (const runs of [[greenPush(sibling), greenPush(absent)], [{ ...greenPush(green), head_sha: 'abc' }]]) {
        const unrelated = plan(listed(runs));
        expect(unrelated.mode).toBe('full');
        expect(unrelated.paths).toEqual([]);
      }

      // (d) Every failed lookup runs everything and never fails the planning step itself.
      for (const routes of [
        // The first push of a branch: no push run of it has succeeded yet.
        listed([]),
        // The run's own workflow is unreadable, so no list is requested.
        { [RUN_LOOKUP]: { exit: 1, stderr: 'gh: Server Error (HTTP 502)\n' } },
        { [RUN_LOOKUP]: { stdout: 'null\n' } },
        {
          ...listed([]),
          [RUNS_LIST]: { exit: 1, stderr: 'gh: API rate limit exceeded for installation ID 1. (HTTP 403)\n' },
        },
        { ...listed([]), [RUNS_LIST]: { exit: 1, stderr: 'gh: Server Error (HTTP 500)\n' } },
        { ...listed([]), [RUNS_LIST]: { stdout: '<html>unicorn</html>' } },
        { ...listed([]), [RUNS_LIST]: { stdout: '{"message":"Not Found"}' } },
      ]) {
        const failed = plan(routes);
        expect(failed.mode).toBe('full');
        expect(failed.paths).toEqual([]);
        expect(failed.log).toContain('::warning title=Complete suite::');
      }

      // A push to main (behind its merge queue) never enters the lookup: it compares with the commit before the push
      // as it always did, and calls no API.
      for (const value of ['false', '']) {
        const queued = plan(listed([greenPush(green)]), { NEWEST_GREEN_BASE: value });
        expect(queued.calls, value).toEqual([]);
        expect(queued.paths, value).toEqual(['pushed.ts']);
      }
      // A commit the queue-proof job proved plans no gate and names the proving run; force-ci-full never skips.
      const proof = 'https://github.com/TechsioCZ/ontos/actions/runs/44490000000';
      const proven = plan({}, { PROOF_RUN: proof, QUEUE_PROVEN: 'true' });
      expect(proven.mode).toBe('proven');
      expect(proven.calls).toEqual([]);
      expect(proven.log).toContain(`Run ${proof} already proved this exact commit.`);
      expect(plan({}, { FORCE_FULL: 'true', NEWEST_GREEN_BASE: 'false', QUEUE_PROVEN: 'true' }).mode).toBe('full');
      // Nor does any other event without a queue proof.
      for (const event of ['merge_group', 'pull_request', 'schedule', 'workflow_dispatch']) {
        expect(plan({}, { GITHUB_EVENT_NAME: event }).calls, event).toEqual([]);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);

it('keeps every unit and integration template resolvable so one glob cannot disable affected selection', () => {
  for (const command of templates.unit.flatMap(({ commands }) => commands.split('\n').filter(Boolean))) {
    expect(unknownFilters(command)).toBe(false);
    expect(filterPaths(command).filter(({ path: selected }) => !knownSelectors.has(selected ?? ''))).toEqual([]);
  }
  for (const task of templates.integration.flatMap((entry) => entry.tasks ?? [])) {
    expect(knownTask(task), task).toBe(true);
    expect(knownSelectors.has(taskDirectory(task) ?? '.'), task).toBe(true);
  }
});

const WEIGHTED_SHARD_LINE =
  /^pnpm --filter \.\/[a-z0-9/-]+ exec bash \S*rstest-weighted-shard\.sh"? (?<index>\d+)\/(?<count>\d+) (?<project>[a-z-]+)(?:\s|$)/u;
const RECURSIVE_SCRIPT_LINE = / run (?<script>test:[a-z]+)(?:\s|$)/u;

// Demo carries many verticals the engineered line does not have: a matrix that names packages one by one would
// silently skip a new one, so the catch-all rows must keep every suite in exactly one place.
it('runs every unit and component suite of every workspace package exactly once across the unit rows', () => {
  const recursive: string[] = [];
  const weighted = new Map<string, { readonly count: string; readonly indices: string[] }>();
  for (const line of templates.unit.flatMap(({ commands }) => commands.split('\n').filter(Boolean))) {
    const shard = WEIGHTED_SHARD_LINE.exec(line)?.groups;
    const script = RECURSIVE_SCRIPT_LINE.exec(line)?.groups?.script;
    const directories = matchingPackages(line, workspacePackages).map(({ directory }) => directory);
    expect(shard !== undefined || script !== undefined).toBe(true);
    for (const directory of directories) {
      if (shard === undefined) {
        recursive.push(`${directory} ${script ?? ''}`);
      } else {
        const key = `${directory} test:${shard.project ?? ''}`;
        const family = weighted.get(key) ?? { count: shard.count ?? '', indices: [] };
        expect(family.count).toBe(shard.count);
        family.indices.push(shard.index ?? '');
        weighted.set(key, family);
      }
    }
  }
  // A weighted family runs each of its shards exactly once, and together they run the whole project.
  for (const { count, indices } of weighted.values()) {
    expect(indices.toSorted()).toEqual(Array.from({ length: Number(count) }, (_, index) => String(index + 1)));
  }
  const runs = [...recursive, ...weighted.keys()];
  expect(new Set(runs).size).toBe(runs.length);
  const required = workspacePackages.flatMap(({ directory, scripts }) =>
    ['test:unit', 'test:component']
      .filter((script) => scripts[script] !== undefined)
      .map((script) => `${directory} ${script}`),
  );
  expect(required.filter((run) => !runs.includes(run))).toEqual([]);
});

it('runs the integration suite of every workspace package that declares one in some integration row', () => {
  const covered = new Set(templates.integration.flatMap(taskDirectories));
  expect(
    workspacePackages
      .filter(({ scripts }) => scripts['test:integration'] !== undefined)
      .map(({ directory }) => directory)
      .filter((directory) => !covered.has(directory)),
  ).toEqual([]);
});

/** The keys a schema's fields allow and those it requires, in declaration order. */
const declared = (
  fields: Readonly<
    Record<string, { readonly ast: { readonly context?: { readonly isOptional: boolean } | undefined } }>
  >,
) => ({
  allowed: Object.keys(fields),
  required: Object.entries(fields)
    .filter(([, field]) => field.ast.context?.isOptional !== true)
    .map(([key]) => key),
});

it('checks the matrices without installing against the keys the installed decode declares', () => {
  const { fields } = CiTemplatesSchema;
  expect(declared(fields)).toEqual(CI_MATRICES_KEYS.matrices);
  expect(declared(fields.source.value.fields)).toEqual(CI_MATRICES_KEYS.command);
  expect(declared(fields.unit.value.fields)).toEqual(CI_MATRICES_KEYS.command);
  expect(declared(fields.integration.value.fields)).toEqual(CI_MATRICES_KEYS.integration);
  expect(declared(fields.scopes.schema.value.fields)).toEqual(CI_MATRICES_KEYS.scope);
});

const NO_INSTALL_PLANNER = 'scripts/plan-ci-without-install.sh';
const DEMO_OVERLAY = 'scripts/ci-matrices.demo.json';
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const PNPM_WORKSPACE = 'pnpm-workspace.yaml';
const APPLY_AFFECTED = '--apply-affected';
/** The value of one GITHUB_OUTPUT line. */
const outputLine = (output: string, key: string) =>
  output
    .split('\n')
    .find((entry) => entry.startsWith(`${key}=`))
    ?.slice(key.length + 1);

it('plans with nothing installed, from the matrices rows as the installed tools decode them', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ontos-ci-without-deps-'));
  const copy = (file: string) => {
    const target = path.join(fixture, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(appRoot, file)));
  };
  const outputs = path.join(fixture, 'output');
  const paths = path.join(fixture, 'paths');
  const plan = (cwd: string, flags: readonly string[]) => {
    writeFileSync(outputs, '');
    const log = execFileSync('/bin/bash', [NO_INSTALL_PLANNER, '--paths-file', paths, ...flags], {
      cwd,
      encoding: 'utf-8',
      env: {
        CI_MATRICES_OVERLAY: DEMO_OVERLAY,
        GITHUB_OUTPUT: outputs,
        GITHUB_STEP_SUMMARY: path.join(fixture, 'summary'),
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
      stdio: 'pipe',
    });
    return { log, output: readFileSync(outputs, 'utf-8') };
  };
  try {
    for (const file of [
      PACKAGE_MANIFEST,
      PNPM_WORKSPACE,
      'topology/ownership.json',
      'topology/reference-topology.json',
      'scripts/ci-matrices.json',
      DEMO_OVERLAY,
      'scripts/ci/ci-matrices-rules.mts',
      'scripts/plan-ci-checks.mts',
      'scripts/workspace-consumer-closure.mts',
      NO_INSTALL_PLANNER,
    ]) {
      copy(file);
    }
    for (const { directory } of workspacePackages) {
      copy(path.join(directory, PACKAGE_MANIFEST));
    }
    expect(existsSync(path.join(fixture, 'node_modules'))).toBe(false);
    for (const [changed, flags] of [
      [CATALOG_SOURCE, [APPLY_AFFECTED]],
      ['app/scripts/check.mts', [APPLY_AFFECTED]],
      [CATALOG_SOURCE, ['--full', APPLY_AFFECTED]],
    ] as const) {
      writeFileSync(paths, `${changed}\0`);
      // Only the copied files: the same plan as in the installed workspace.
      expect(plan(fixture, flags), changed).toEqual(plan(appRoot, flags));
    }
    // A complete plan hands every row on exactly as the installed tools' strict decode reads it, key order included.
    const { output } = plan(fixture, ['--full']);
    expect(outputLine(output, 'mode')).toBe('full');
    expect(outputLine(output, 'source')).toBe(encodeJson(templates.source));
    expect(outputLine(output, 'unit')).toBe(encodeJson(templates.unit.filter((row) => row['node-artifacts'] !== true)));
    expect(outputLine(output, 'integrationOwners')).toBe(
      encodeJson(templates.integration.filter(({ suite }) => suite === 'integration')),
    );
    // Matrices the planner cannot plan from fail the plan job.
    const overlay = readFileSync(path.join(appRoot, DEMO_OVERLAY), 'utf-8');
    for (const [broken, reason] of [
      [overlay.replace('{', '{"unknown": [],'), /the overlay has the unknown key unknown/u],
      [
        `{"integration": [{"name": "Unrunnable", "suite": "integration", "tasks": ["nowhere"]}]}`,
        /runnable task form/u,
      ],
      [`{"integration": [{"name": "Unknown suite", "suite": "smoke"}]}`, /names no known suite/u],
      [`{"source": [{"commands": "true"}]}`, /lacks the key name/u],
    ] as const) {
      writeFileSync(path.join(fixture, DEMO_OVERLAY), broken);
      expect(() => plan(fixture, []), broken).toThrow(reason);
    }
    writeFileSync(path.join(fixture, DEMO_OVERLAY), overlay);
    // A workspace the planner cannot resolve runs the complete suite.
    const workspace = readFileSync(path.join(appRoot, PNPM_WORKSPACE), 'utf-8');
    writeFileSync(path.join(fixture, PNPM_WORKSPACE), workspace.replace('  - apps/*', '  - apps/**'));
    writeFileSync(paths, `${CATALOG_SOURCE}\0`);
    const unresolved = plan(fixture, [APPLY_AFFECTED]);
    expect(unresolved.log).toContain(
      'unsupported pnpm-workspace.yaml package entry apps/**. Running the complete suite.',
    );
    expect(outputLine(unresolved.output, 'mode')).toBe('full');
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
