import { readFileSync } from 'node:fs';

import { Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseCiMatrices, taskDirectory } from '../ci/ci-matrices.mts';
import type { CiWorkspacePackage } from '../plan-ci-checks.mts';
import { planCiChecks } from '../plan-ci-checks.mts';

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
 * The storefronts are leaves with no integration task, the root package owns `app/scripts`, and the Shell and the
 * root consume the verticals through their public surface.
 */
const named: readonly CiWorkspacePackage[] = [
  { dependencies: [], directory: AKROS, name: AKROS },
  { dependencies: [CUSTOMER_CONTEXT], directory: N1, name: N1 },
  { dependencies: [], directory: 'verticals/commerce-customer-context', name: CUSTOMER_CONTEXT },
  { dependencies: [], directory: WORK_TASKS_DIRECTORY, name: WORK_TASKS },
  {
    dependencies: [],
    directory: FINANCE_DIRECTORY,
    exportTargets: ['src/worker-host/entry.ts'],
    name: FINANCE_BILLING,
  },
  { dependencies: [FINANCE_BILLING], directory: 'apps/shell-super-app', name: SHELL },
  { dependencies: [SHELL], directory: '.', name: 'app' },
];
/**
 * Every other owner a task or the native preproposal proof names, as a vertical named after its directory; a task
 * outside the workspace or an unknown proof package widens every run.
 */
const owners = [
  ...templates.integration.flatMap(({ tasks }) => (tasks ?? []).map(taskDirectory)),
  ...templates.integration.flatMap((entry) =>
    (entry['proof-packages'] ?? []).map((name) => `verticals/${name.replace('@app/', '')}`),
  ),
]
  .filter((directory): directory is string => directory !== undefined)
  .map((directory) => ({ dependencies: [], directory, name: `@app/${directory.split('/').at(-1) ?? directory}` }));
const packages: readonly CiWorkspacePackage[] = [
  ...named,
  ...owners.filter(
    (owner, index) =>
      owners.findIndex(({ directory }) => directory === owner.directory) === index &&
      !named.some(({ directory, name }) => directory === owner.directory || name === owner.name),
  ),
];

const plan = (...changedPaths: readonly string[]) =>
  planCiChecks({ applyAffected: true, changedPaths, packages, templates });
const names = (entries: readonly { readonly name: string }[]) => entries.map(({ name }) => name);
const EVERY_OTHER_PACKAGE = 'Unit and Component Tests (every other package)';
/** The typecheck row, which also typechecks the storefronts. */
const TYPECHECK = 'Typecheck and OntOS API Boundary Rules';
const ROOT_TOOLING_FILE = 'app/scripts/check-local.mts';
const STAGE_WORKFLOW = '.github/workflows/zerops-stage.yml';
const TOOLING_ROWS = [1, 2, 3].map((shard) => `Repository Tooling Tests (${shard}/3)`);
/** A scoped plan builds no unit, starts no service and always runs its source rows, the static contracts and lint. */
const SCOPED = {
  'format-and-lint': 'success',
  'node-artifact-build': 'skipped',
  'service-integration': 'skipped',
  'static-contracts': 'success',
  'workspace-gate': 'success',
  'workspace-unit': 'skipped',
  'workspace-unit-artifacts': 'skipped',
};
const SCOPED_WITH_UNIT = { ...SCOPED, 'workspace-unit': 'success' };
const BOOTSTRAP = templates.integration.filter(({ suite }) => suite === 'bootstrap');
const BOOTSTRAP_NAME = 'Deployment Bootstrap and Node Federation Proof';
const CORE_RUNTIME_MIGRATIONS = 'whole:core-runtime-migrations';
const CUSTOMER_CONTEXT_MIGRATIONS = 'whole:customer-context-migrations';
const PARTY_MIGRATIONS = 'whole:party-migrations';
const ownerTasks = (entries: typeof templates.integration) => entries.flatMap(({ tasks }) => tasks ?? []);
const sorted = (values: readonly string[]) => values.toSorted((left, right) => left.localeCompare(right));

it('runs only the storefront scope for a change confined to the storefronts', () => {
  for (const directory of rootLevelPackageDirectories) {
    const storefront = plan(`app/${directory}/src/app/page.tsx`);
    expect(storefront.mode, directory).toBe('scoped');
    expect(storefront.affectedPackages, directory).toEqual([directory]);
    // The typecheck and the tooling tests that read storefront files, nothing else from the source rows.
    expect(names(storefront.source), directory).toEqual([TYPECHECK, ...TOOLING_ROWS]);
    expect(names(storefront.unit), directory).toEqual([EVERY_OTHER_PACKAGE]);
    expect(storefront.unit[0]?.commands, directory).toContain(`--filter ./${directory} run test:unit`);
    // A storefront is in no unit build: no build, Node proof, service, database or browser job is paid for.
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
  expect(names(both.source)).toEqual([TYPECHECK, ...TOOLING_ROWS]);
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
    source: templates.source.map((entry) => (entry.name === TYPECHECK ? { ...entry, name: 'Typecheck' } : entry)),
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
  // The repository tooling tests are source rows; the root integration tasks prove the rest, next to the bootstrap
  // row every affected plan keeps.
  expect(names(scripts.source).filter((name) => name.startsWith('Repository Tooling Tests'))).toHaveLength(3);
  const rootTasks = ownerTasks(templates.integration).filter(
    (task) => task.startsWith('root:') || ['whole:customer-readback', 'whole:customer-roundtrip'].includes(task),
  );
  expect(rootTasks.length).toBeGreaterThan(20);
  expect(scripts.integration.filter(({ suite }) => suite === 'bootstrap')).toEqual(BOOTSTRAP);
  expect(scripts.integration.filter(({ suite }) => suite === 'browser')).toEqual([]);
  const selected = ownerTasks(scripts.integration);
  expect(selected).toEqual(expect.arrayContaining(rootTasks));
  expect(selected.every((task) => task.startsWith('root:') || task.startsWith('whole:'))).toBe(true);
  expect(selected.some((task) => task.startsWith('whole:privacy') || task === 'whole:pricing')).toBe(false);
  // The root package is in no unit row (`--filter '!.'`), and app/scripts/check-ci-gates.sh requires the workspace
  // unit gate to have run in an affected plan, so the unit matrix stays complete; the integration matrix narrows.
  expect(scripts.unit).toEqual(templates.unit);
  expect(scripts.expected['workspace-unit']).toBe('success');
  expect(scripts.expected['workspace-unit-artifacts']).toBe('success');
  expect(scripts.expected['service-integration']).toBe('success');
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

/** Migration equivalence runs on the bootstrap row, in app/rstest.config.ts's owned-cluster project. */
const MIGRATION_EQUIVALENCE_TEST = 'scripts/integration/migration-equivalence.test.mts';
/**
 * The demo trunk's Fresh Database rows (9d6c775b4), read from its planner and matrices: every changed path that
 * named a new integration seed (`integrationSeedInputs` of scripts/plan-ci-checks.mts) or one of the
 * fresh-database tests (`fresh-database-tests` of both matrices files) selected them, and they ran these files. The owner rows must still run every one of them for
 * those paths, never fewer tests than that planner.
 */
const BASE_FRESH_DATABASE_INPUTS: readonly string[] = [
  'app/**/drizzle*/**',
  'app/**/drizzle*.config.ts',
  'app/database/**',
  'app/scripts/postgres/**',
  'app/scripts/run-zerops-migrator.mjs',
  'app/scripts/migration-convergence*',
  'app/scripts/access-release-activation*',
  'app/scripts/activate-access-catalog-release.mts',
  'app/scripts/application-migration-pending.mts',
  'app/verticals/commerce-customer-context/scripts/**',
  'app/scripts/run-optional-commerce-portal-auth-db.mts',
  'app/scripts/verify-application-db-schema.mts',
  'app/scripts/audit-database-trust-boundaries.mts',
  'app/scripts/prove-zerops-migrator-artifact.sh',
  'app/scripts/ci/integration-seed*.mts',
  // The fresh-database tests: a change to that list changes which rows may restore the seed.
  'app/scripts/ci-matrices*.json',
  'app/scripts/ci/ci-matrices.mts',
  'app/packages/core-runtime/spicedb/**',
  'app/packages/core-runtime/src/install/**',
  'app/packages/core-runtime/src/access/**',
  'app/packages/core-runtime/src/permissions/**',
  'app/packages/core-runtime/src/db/**',
  'app/topology/**',
  'app/docker-compose.yml',
  'app/zerops.yaml',
  'app/package.json',
  'app/pnpm-lock.yaml',
  'app/.mise.toml',
  '!app/**/node_modules/**',
  '!app/tools/**',
];
const BASE_FRESH_DATABASE_TESTS = [
  'scripts/integration/migrator-runtime-owner-access.test.mts',
  'packages/core-runtime/tests/integration/application-composition-authority-migration.test.ts',
  'packages/core-runtime/tests/integration/application-composition-durable-work-migration.test.ts',
  'packages/core-runtime/tests/integration/auth-namespace-migration.test.ts',
  'packages/core-runtime/tests/integration/contacts-identity-migration.test.ts',
  'verticals/commerce-customer-context/tests/integration/organization-profile-ico-migration-postgres.test.ts',
  'verticals/party-registry/tests/integration/official-identifier-original-input-migration.test.ts',
  'verticals/party-registry/tests/integration/verification-removal-migration.test.ts',
  MIGRATION_EQUIVALENCE_TEST,
  'scripts/integration/stage-recovery-lifecycle.test.mts',
  'scripts/integration/vat-deploy-sequence.test.mts',
  'packages/core-runtime/tests/integration/action-authority-v2-migration.test.ts',
  'packages/core-runtime/tests/integration/search-v2-cutover-migration.test.ts',
  'verticals/commerce-customer-context/tests/integration/stage-recovery-lane15-lifecycle.test.ts',
  'verticals/work-tasks/tests/integration/assignment-migration.test.mts',
  'verticals/merchandise/tests/integration/tax-classification-migration-postgres.test.ts',
  'verticals/finance-billing/tests/integration/imported-payment-records-migration-postgres.test.ts',
  'verticals/finance-billing/tests/integration/vat-classification-migration-postgres.test.ts',
];
/**
 * The files those rows ran, their fresh-database tests of the root suite, Core Runtime, Customer Context and Party, by
 * the task that runs each alone (scripts/ci/run-integration-suites.sh); migration equivalence runs on the bootstrap
 * row (app/rstest.config.ts, owned-cluster project).
 */
const BASE_FRESH_ROW_TASKS = new Map([
  [MIGRATION_EQUIVALENCE_TEST, BOOTSTRAP_NAME],
  ['scripts/integration/migrator-runtime-owner-access.test.mts', 'whole:migrator-owner-access'],
  ['scripts/integration/stage-recovery-lifecycle.test.mts', 'whole:stage-recovery'],
  ['scripts/integration/vat-deploy-sequence.test.mts', 'whole:vat-deploy-sequence'],
  ['packages/core-runtime/tests/integration/action-authority-v2-migration.test.ts', CORE_RUNTIME_MIGRATIONS],
  [
    'packages/core-runtime/tests/integration/application-composition-authority-migration.test.ts',
    CORE_RUNTIME_MIGRATIONS,
  ],
  [
    'packages/core-runtime/tests/integration/application-composition-durable-work-migration.test.ts',
    CORE_RUNTIME_MIGRATIONS,
  ],
  ['packages/core-runtime/tests/integration/auth-namespace-migration.test.ts', CORE_RUNTIME_MIGRATIONS],
  ['packages/core-runtime/tests/integration/contacts-identity-migration.test.ts', CORE_RUNTIME_MIGRATIONS],
  ['packages/core-runtime/tests/integration/search-v2-cutover-migration.test.ts', CORE_RUNTIME_MIGRATIONS],
  [
    'verticals/commerce-customer-context/tests/integration/organization-profile-ico-migration-postgres.test.ts',
    CUSTOMER_CONTEXT_MIGRATIONS,
  ],
  [
    'verticals/commerce-customer-context/tests/integration/stage-recovery-lane15-lifecycle.test.ts',
    CUSTOMER_CONTEXT_MIGRATIONS,
  ],
  ['verticals/party-registry/tests/integration/official-identifier-original-input-migration.test.ts', PARTY_MIGRATIONS],
  ['verticals/party-registry/tests/integration/verification-removal-migration.test.ts', PARTY_MIGRATIONS],
]);
/** A concrete changed path a glob of that list matches. */
const samplePath = (glob: string) => glob.replaceAll('**', 'sample').replaceAll('*', 'sample');
/** What the base planned beside those rows for a migration input the root package owns: the root suite. */
const ROOT_TASKS = [
  ...Array.from({ length: 27 }, (_, index) => `root:${index + 1}/27`),
  'whole:customer-readback',
  'whole:customer-roundtrip',
  'whole:organization',
  'whole:organization-identity',
  'whole:pricing-routes',
];
const MIGRATION_PROOF_TASKS = [
  'whole:migrator-owner-access',
  'whole:stage-recovery',
  'whole:vat-deploy-sequence',
  CORE_RUNTIME_MIGRATIONS,
  CUSTOMER_CONTEXT_MIGRATIONS,
  PARTY_MIGRATIONS,
];

it('runs every file of the former Fresh Database rows for every path that selected them', () => {
  const inputs = [
    ...BASE_FRESH_DATABASE_INPUTS.filter((glob) => !glob.startsWith('!')).map(samplePath),
    ...BASE_FRESH_DATABASE_TESTS.map((testFile) => `app/${testFile}`),
  ];
  for (const changedPath of inputs) {
    const selected = plan(changedPath);
    const planned = new Set([...ownerTasks(selected.integration), ...names(selected.integration)]);
    const missing = [...BASE_FRESH_ROW_TASKS].filter(([, task]) => !planned.has(task));
    expect(missing, changedPath).toEqual([]);
  }
  // The tasks are real: each runs once on an owner row, beside the bootstrap row.
  for (const task of MIGRATION_PROOF_TASKS) {
    expect(
      ownerTasks(templates.integration).filter((candidate) => candidate === task),
      task,
    ).toHaveLength(1);
  }
  expect(names(BOOTSTRAP)).toEqual([BOOTSTRAP_NAME]);
  // A migration input the root package owns runs those tasks beside the root suite, as the base ran those rows beside
  // its root rows, and never the complete suite.
  for (const changedPath of [
    'app/scripts/run-zerops-migrator.mjs',
    'app/scripts/verify-application-db-schema.mts',
    'app/scripts/prove-zerops-migrator-artifact.sh',
  ]) {
    const selected = plan(changedPath);
    expect(selected.mode, changedPath).toBe('affected');
    expect(sorted(ownerTasks(selected.integration)), changedPath).toEqual(
      sorted([...ROOT_TASKS, ...MIGRATION_PROOF_TASKS]),
    );
    expect(names(selected.integration.filter(({ suite }) => suite !== 'integration')), changedPath).toEqual(
      names(templates.integration.filter(({ suite }) => suite === 'database' || suite === 'bootstrap')),
    );
  }
});

it('starts no owner row for a package with no integration task', () => {
  // A package without `test:integration` has no task in the matrices: no owner row and no database is paid for,
  // only the bootstrap row every affected plan keeps.
  const taskState = plan(`app/${WORK_TASKS_DIRECTORY}/src/services/task-state.ts`);
  expect(taskState.mode).toBe('affected');
  expect(taskState.affectedPackages).toEqual([WORK_TASKS]);
  expect(taskState.integration).toEqual(BOOTSTRAP);
  expect(taskState.expected['service-integration']).toBe('skipped');
  // A package that has one selects exactly its own task, on the row that holds it.
  const invoices = plan(`app/${FINANCE_DIRECTORY}/src/services/invoice-totals.ts`);
  expect(ownerTasks(invoices.integration)).toEqual([`./${FINANCE_DIRECTORY}`]);
  expect(invoices.integration.filter(({ suite }) => suite === 'integration')).toHaveLength(1);
  expect(invoices.expected['service-integration']).toBe('success');
});

it('satisfies the gate aggregator for every narrowed plan it can produce', () => {
  // app/scripts/check-ci-gates.sh: in an affected plan every gate outside its optional list must be 'success', and
  // at least one of the two workspace unit gates must have run. A plan that skips them is rejected, not green.
  const optional = new Set(['workspace-unit', 'workspace-unit-artifacts', 'service-integration']);
  for (const changedPath of [
    ROOT_TOOLING_FILE,
    'app/scripts/ci/build-units.sh',
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
