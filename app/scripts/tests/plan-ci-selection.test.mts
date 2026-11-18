import { readFileSync } from 'node:fs';

import { Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseCiMatrices } from '../ci/ci-matrices.mts';
import type { CiWorkspacePackage } from '../plan-ci-checks.mts';
import { integrationSeedInputs, planCiChecks } from '../plan-ci-checks.mts';

/** The demo trunk's matrices: the shared file with the overlay its gates workflow names. */
const templates = Result.getOrThrow(
  parseCiMatrices(
    readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
    readFileSync(new URL('../ci-matrices.demo.json', import.meta.url), 'utf-8'),
  ),
);
const rootLevelPackageDirectories = templates['root-packages'] ?? [];

const AKROS = 'akros-storefront';
const N1 = 'n1-storefront';
const SHELL = '@app/shell-super-app';
const CUSTOMER_CONTEXT = '@app/commerce-customer-context';
const WORK_TASKS = '@app/work-tasks';
const WORK_TASKS_DIRECTORY = 'verticals/work-tasks';
const FINANCE_BILLING = '@app/finance-billing';
const FINANCE_DIRECTORY = 'verticals/finance-billing';

/**
 * The storefronts are leaves with no integration suite, the root package owns `app/scripts`, and the Shell and the
 * root consume the verticals through their public surface.
 */
const packages: readonly CiWorkspacePackage[] = [
  { dependencies: [], directory: AKROS, integrationSuite: false, name: AKROS },
  { dependencies: [CUSTOMER_CONTEXT], directory: N1, integrationSuite: false, name: N1 },
  {
    dependencies: [],
    directory: 'verticals/commerce-customer-context',
    integrationSuite: true,
    name: CUSTOMER_CONTEXT,
  },
  { dependencies: [], directory: WORK_TASKS_DIRECTORY, integrationSuite: false, name: WORK_TASKS },
  {
    dependencies: [],
    directory: FINANCE_DIRECTORY,
    exportTargets: ['src/worker-host/entry.ts'],
    integrationSuite: true,
    name: FINANCE_BILLING,
  },
  { dependencies: [FINANCE_BILLING], directory: 'apps/shell-super-app', integrationSuite: true, name: SHELL },
  { dependencies: [SHELL], directory: '.', integrationSuite: true, name: 'app' },
  // The native preproposal proof names its runtime owners; an unknown one widens every run.
  ...['party-registry', 'commerce-cart', 'catalog', 'storefront-registry', 'commerce-market-catalog', 'pricing'].map(
    (unit): CiWorkspacePackage => ({
      dependencies: [],
      directory: `verticals/${unit}`,
      integrationSuite: true,
      name: `@app/${unit}`,
    }),
  ),
];

const plan = (...changedPaths: readonly string[]) =>
  planCiChecks({ applyAffected: true, changedPaths, packages, templates });
const names = (entries: readonly { readonly name: string }[]) => entries.map(({ name }) => name);
const EVERY_OTHER_PACKAGE = 'Unit and Component Tests (every other package)';
const STOREFRONT_TYPECHECK = 'Storefront Typecheck (AKROS and N1)';
const ROOT_TOOLING_FILE = 'app/scripts/check-local.mts';
const STAGE_WORKFLOW = '.github/workflows/zerops-stage.yml';
const TOOLING_ROWS = [1, 2, 3].map((shard) => `Repository Tooling Tests (${shard}/3)`);
/** A scoped plan builds no unit, starts no service and always runs its source rows, the static contracts and lint. */
const SCOPED = {
  'browser-integration': 'skipped',
  'format-and-lint': 'success',
  'integration-seed-proof': 'skipped',
  'node-artifact-build': 'skipped',
  'node-artifact-proof': 'skipped',
  'service-integration': 'skipped',
  'static-contracts': 'success',
  'workspace-gate': 'success',
  'workspace-unit': 'skipped',
  'workspace-unit-artifacts': 'skipped',
};
const SCOPED_WITH_UNIT = { ...SCOPED, 'workspace-unit': 'success' };
const fresh = (entries: readonly { readonly 'fresh-database-tests'?: string }[]) =>
  entries.filter((entry) => entry['fresh-database-tests'] === 'only');

it('runs only the storefront scope for a change confined to the storefronts', () => {
  for (const directory of rootLevelPackageDirectories) {
    const storefront = plan(`app/${directory}/src/app/page.tsx`);
    expect(storefront.mode, directory).toBe('scoped');
    expect(storefront.affectedPackages, directory).toEqual([directory]);
    // The storefront typecheck and the tooling tests that read storefront files, nothing else from the source rows.
    expect(names(storefront.source), directory).toEqual([...TOOLING_ROWS, STOREFRONT_TYPECHECK]);
    expect(names(storefront.unit), directory).toEqual([EVERY_OTHER_PACKAGE]);
    expect(storefront.unit[0]?.commands, directory).toContain(`--filter ./${directory} run test:unit`);
    // A storefront is in no unit build: no build, Node proof, service, seed or browser job is paid for.
    expect(storefront.integration, directory).toEqual([]);
    expect(storefront.expected, directory).toEqual(SCOPED_WITH_UNIT);
  }
  const both = plan(`app/${AKROS}/src/lib/cart.ts`, `app/${N1}/src/catalog/view.tsx`, 'README.md');
  expect(both.mode).toBe('scoped');
  expect(both.affectedPackages).toEqual([AKROS, N1]);
  expect(both.unit[0]?.commands).toContain(`--filter ./${AKROS} --filter ./${N1} run test:unit`);
  // The generated catalogue a Merchandise script reads is outside the scope.
  expect(plan(`app/${AKROS}/src/catalog-import/generated/catalog.generated.json`).mode).toBe('affected');
});

it('runs only the tooling tests for a change confined to the stage delivery or the tooling tests', () => {
  for (const changedPaths of [
    // 2d3ec0217 and 7795ec87d on the demo trunk, 17 Nov.
    [
      '.github/actions/deliver-stage/action.yml',
      STAGE_WORKFLOW,
      'app/scripts/tests/zerops-deployment-contract.test.mts',
      'app/scripts/tests/zerops-plan-setup.test.mts',
      'app/scripts/zerops/prove-app-runtime.mts',
      'app/scripts/zerops/prove-app-runtime.test.mts',
      'app/scripts/zerops/read-delivery-history.sh',
      'app/scripts/zerops/reuse-shard-units.sh',
      'app/scripts/zerops/reuse-shard-units.test.mts',
    ],
    ['app/scripts/zerops/app-boot-stages.sh', 'app/scripts/zerops/app-boot-stages.test.mts'],
    ['app/scripts/tests/ci-workflows.test.mts', 'docs/README.md'],
    // The merge planner reads its verdict table; scripts/merge/plan.test.mts proves the table, 44284859528 ran full.
    ['app/docs/architecture/MERGING.md'],
  ]) {
    const stage = plan(...changedPaths);
    expect(stage.mode, changedPaths[0]).toBe('scoped');
    expect(names(stage.source), changedPaths[0]).toEqual(TOOLING_ROWS);
    expect(stage.unit, changedPaths[0]).toEqual([]);
    expect(stage.expected, changedPaths[0]).toEqual(SCOPED);
  }
  // Both scopes at once run both scopes' rows.
  const both = plan(STAGE_WORKFLOW, `app/${AKROS}/src/app/page.tsx`);
  expect(both.mode).toBe('scoped');
  expect(names(both.source)).toEqual([...TOOLING_ROWS, STOREFRONT_TYPECHECK]);
  // What the app host, the unit builds, the gates or the integration suites run is outside the scope.
  for (const changedPath of [
    'app/scripts/zerops/app-host.mts',
    'app/scripts/zerops/build-app.sh',
    'app/scripts/zerops/owner-entry.mts',
    'app/scripts/zerops/delivery-plan.mts',
    'app/scripts/zerops/app-runtime-paths.txt',
    'app/zerops.yaml',
    '.github/workflows/ultramodern-workspace-gates.yml',
    'app/scripts/integration/stage-recovery-lifecycle.test.mts',
    'app/scripts/tests/outbox-worker-host-proof-native.fixture.mts',
    'app/docs/architecture/DEPLOYMENT.md',
  ]) {
    expect(plan(STAGE_WORKFLOW, changedPath).mode, changedPath).not.toBe('scoped');
  }
  // An authority-named tooling test stays sensitive, and nothing is scoped outside a narrowed run.
  expect(plan('app/scripts/tests/authorization-catalog.test.mts').mode).toBe('full');
  expect(planCiChecks({ applyAffected: false, changedPaths: [STAGE_WORKFLOW], packages, templates }).mode).toBe('full');
  expect(
    planCiChecks({
      applyAffected: true,
      changedPaths: [STAGE_WORKFLOW],
      forceFull: true,
      packages,
      templates,
    }).mode,
  ).toBe('full');
});

it('refuses a scope that names a source row the matrices do not have', () => {
  const renamed = {
    ...templates,
    source: templates.source.map((entry) =>
      entry.name === STOREFRONT_TYPECHECK ? { ...entry, name: 'Storefront Typecheck' } : entry,
    ),
  };
  expect(
    planCiChecks({ applyAffected: true, changedPaths: [`app/${AKROS}/src/app/page.tsx`], packages, templates: renamed })
      .mode,
  ).toBe('affected');
});

it('keeps the manifest, config, schema and authority rules widening inside the storefront trees', () => {
  for (const file of [
    'package.json',
    'next.config.ts',
    'vitest.config.ts',
    'src/db/schema.ts',
    'src/auth/session.ts',
  ]) {
    expect(plan(`app/${AKROS}/${file}`).mode, file).toBe('full');
  }
});

it('widens nothing from a storefront while still following the edge into it', () => {
  // A storefront is a leaf: no workspace package depends on it, so its own change reaches no consumer.
  expect(plan(`app/${N1}/src/catalog/view.tsx`).affectedPackages).toEqual([N1]);
  expect(plan(`app/${AKROS}/src/app/page.tsx`).affectedPackages).toEqual([AKROS]);
  // The edge into it is real: a change to the public surface of what N1 consumes selects N1 as a consumer.
  const surface = plan('app/verticals/commerce-customer-context/vertical.runtime-declaration.ts');
  expect(surface.mode).toBe('affected');
  expect(surface.affectedPackages).toContain(N1);
  expect(surface.unit.map(({ commands }) => commands).join('\n')).toContain(`--filter ./${N1} run test:unit`);
  // A vertical N1 does not consume never selects it.
  expect(plan(`app/${FINANCE_DIRECTORY}/src/worker-host/entry.ts`).affectedPackages).not.toContain(N1);
});

it('selects the root suites for a change confined to app/scripts and keeps the rest of the root unowned', () => {
  const scripts = plan(ROOT_TOOLING_FILE);
  expect(scripts.mode).toBe('affected');
  expect(scripts.affectedPackages).toEqual(['app']);
  // The repository tooling tests are source rows; the root integration shards prove the rest.
  expect(names(scripts.source).filter((name) => name.startsWith('Repository Tooling Tests'))).toHaveLength(3);
  expect(names(scripts.integration)).toEqual([
    'Root Integration (1/4)',
    'Root Integration (2/4)',
    'Root Integration (3/4)',
    'Root Integration (4/4)',
  ]);
  // The root package is in no unit row (`--filter '!.'`), and app/scripts/check-ci-gates.sh requires the workspace
  // unit gate to have run in an affected plan, so the unit matrix stays complete; the integration matrix narrows.
  expect(scripts.unit).toEqual(templates.unit);
  expect(scripts.expected['workspace-unit']).toBe('success');
  expect(scripts.expected['workspace-unit-artifacts']).toBe('success');
  expect(scripts.expected['browser-integration']).toBe('skipped');
  expect(scripts.integration).toHaveLength(4);
  // The shared, authority and configuration rules still apply inside app/scripts.
  for (const file of ['authorization/catalog.mts', 'ci/cache-entry-key.config.ts', 'ops/grant-stage-access.mts']) {
    expect(plan(`app/scripts/${file}`).mode, file).toBe('full');
  }
  // Every other root path stays unowned: a workflow change can affect every job.
  for (const changedPath of [
    '.github/workflows/ultramodern-workspace-gates.yml',
    'app/package.json',
    'app/pnpm-lock.yaml',
    'app/topology/ownership.json',
    'app/docker-compose.yml',
  ]) {
    expect(plan(changedPath).mode, changedPath).toBe('full');
  }
});

it('runs the fresh-database rows only for a diff that names a new integration seed', () => {
  // A diff that touches no seed input cannot change what they prove.
  expect(fresh(plan(`app/${WORK_TASKS_DIRECTORY}/src/services/task-state.ts`).integration)).toEqual([]);
  expect(fresh(plan(`app/${AKROS}/src/app/page.tsx`).integration)).toEqual([]);
  expect(fresh(plan(ROOT_TOOLING_FILE).integration)).toEqual([]);
  // Every seed input the narrowing rules can reach in affected mode selects both rows and the seed producer.
  for (const changedPath of [
    'app/scripts/ci/integration-seed-model.mts',
    'app/scripts/postgres/roles.sql',
    'app/scripts/run-zerops-migrator.mjs',
    'app/scripts/migration-convergence-plan.mts',
    'app/scripts/verify-application-db-schema.mts',
    'app/scripts/prove-zerops-migrator-artifact.sh',
    'app/verticals/commerce-customer-context/scripts/seed-portal.mts',
    // The fresh-database tests live in the matrices; editing that list must run the rows that prove it.
    'app/scripts/ci-matrices.json',
    'app/scripts/ci-matrices.demo.json',
    'app/scripts/ci/ci-matrices.mts',
  ]) {
    const seeded = plan(changedPath);
    expect(seeded.mode, changedPath).toBe('affected');
    expect(fresh(seeded.integration), changedPath).toHaveLength(2);
    expect(seeded.expected['integration-seed-proof'], changedPath).toBe('success');
  }
  // A change to one of the very files these rows run selects them as well.
  const freshTest = templates['fresh-database-tests']?.find((file) => file.startsWith(`${WORK_TASKS_DIRECTORY}/`));
  expect(freshTest).toBeDefined();
  expect(fresh(plan(`app/${freshTest ?? ''}`).integration)).toHaveLength(2);
  // Full mode is unchanged: the complete suite always contains them.
  expect(
    fresh(
      planCiChecks({ applyAffected: false, changedPaths: ['app/pnpm-lock.yaml'], packages, templates }).integration,
    ),
  ).toHaveLength(2);
  // The seed input list is the gates' own cache key, glob for glob.
  const seedKey = /integration-seed-v1-[^\n]*hashFiles\((?<globs>[^)]*)\)/u.exec(
    readFileSync(new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url), 'utf-8'),
  )?.groups?.globs;
  expect(seedKey?.split(', ').map((glob) => glob.slice(1, -1))).toEqual(integrationSeedInputs);
  expect(integrationSeedInputs.filter((glob) => glob.startsWith('!'))).toEqual([
    '!app/**/node_modules/**',
    '!app/tools/**',
  ]);
  expect(integrationSeedInputs.every((glob) => glob.replace(/^!/u, '').startsWith('app/'))).toBe(true);
});

it('leaves an integration row out for a package whose manifest declares no integration suite', () => {
  // The exclusion-only row runs `pnpm -r --if-present … run test:integration`: a package without that script makes
  // no suite run, so its services are never started.
  const taskState = plan(`app/${WORK_TASKS_DIRECTORY}/src/services/task-state.ts`);
  expect(taskState.mode).toBe('affected');
  expect(taskState.affectedPackages).toEqual([WORK_TASKS]);
  expect(taskState.integration).toEqual([]);
  // A package that does declare one still selects it.
  const invoices = plan(`app/${FINANCE_DIRECTORY}/src/services/invoice-totals.ts`);
  expect(names(invoices.integration)).toEqual(['Database, Migration, RLS, Authorization, and Outbox Integration']);
  expect(invoices.integration[0]?.['package-filters']).toBe(`--filter ./${FINANCE_DIRECTORY}`);
});

it('satisfies the gate aggregator for every narrowed plan it can produce', () => {
  // app/scripts/check-ci-gates.sh: in an affected plan every gate outside its optional list must be 'success', and
  // at least one of the two workspace unit gates must have run. A plan that skips them is rejected, not green.
  const optional = new Set([
    'workspace-unit',
    'workspace-unit-artifacts',
    'service-integration',
    'integration-seed-proof',
    'browser-integration',
  ]);
  for (const changedPath of [
    ROOT_TOOLING_FILE,
    'app/scripts/ci/integration-seed-model.mts',
    `app/${WORK_TASKS_DIRECTORY}/src/services/task-state.ts`,
    `app/${FINANCE_DIRECTORY}/src/services/invoice-totals.ts`,
  ]) {
    const narrowed = plan(changedPath);
    expect(narrowed.mode, changedPath).toBe('affected');
    for (const [gate, result] of Object.entries(narrowed.expected)) {
      expect(optional.has(gate) ? ['success', 'skipped'] : ['success'], `${changedPath} ${gate}`).toContain(result);
    }
    expect([narrowed.expected['workspace-unit'], narrowed.expected['workspace-unit-artifacts']], changedPath).toContain(
      'success',
    );
  }
});

it('widens a storefront or root-level package the workspace cannot account for', () => {
  const unaccounted: readonly CiWorkspacePackage[][] = [
    [...packages, { dependencies: [], directory: 'other-storefront', name: 'other-storefront' }],
    [...packages, { dependencies: [], directory: AKROS, name: 'renamed-storefront' }],
    packages.map((entry) => (entry.directory === AKROS ? { ...entry, uncertain: true } : entry)),
  ];
  for (const [index, entries] of unaccounted.entries()) {
    expect(
      planCiChecks({
        applyAffected: true,
        changedPaths: [`app/${AKROS}/src/app/page.tsx`],
        packages: entries,
        templates,
      }).mode,
      String(index),
    ).toBe('full');
  }
});
