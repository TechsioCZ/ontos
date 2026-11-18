import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { MUTATION_MARKER, planDelivery, previousVerifiedBase, workspaceClosure } from './delivery-plan.mts';
import type { DeliveryInputs, PriorRun, RunMutation, WorkspacePackage } from './delivery-plan.mts';

const OLD = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const EARLIER = 'c'.repeat(40);
const CRM_DIRECTORY = 'app/verticals/crm';
const SHELL_DIRECTORY = 'app/apps/shell-super-app';
const MERCHANDISE_DIRECTORY = 'app/verticals/merchandise';
const SHELL_PACKAGE = '@app/shell-super-app';
const CRM_ENTRY = 'app/verticals/crm/api/index.ts';
const CRM_PACKAGE = '@app/crm';
const SHELL_ID = 'shell-super-app';
const STOREFRONT_PAGE = 'app/akros-storefront/src/app/page.tsx';
const N1_PAGE = 'app/n1-storefront/src/app/page.tsx';
const ALL = ['app', 'storefront', 'shop', 'n1'];
const units = [
  { directory: SHELL_DIRECTORY, id: SHELL_ID },
  { directory: CRM_DIRECTORY, id: 'crm' },
  { directory: MERCHANDISE_DIRECTORY, id: 'merchandise' },
];
const packages: readonly WorkspacePackage[] = [
  ...units.map((unit) => ({
    directory: unit.directory,
    name: `@app/${unit.id}`,
    workspaceDependencies: ['@app/shared-contracts'],
  })),
  { directory: 'app/packages/shared-contracts', name: '@app/shared-contracts', workspaceDependencies: [] },
  { directory: 'app/akros-storefront', name: 'akros-storefront', workspaceDependencies: [] },
  { directory: 'app/n1-storefront', name: 'n1-storefront', workspaceDependencies: [] },
];
const previousRun: PriorRun = {
  conclusion: 'success',
  head_branch: 'demo/sales-crm',
  head_sha: OLD,
  id: 11,
  path: '.github/workflows/zerops-stage.yml',
  run_attempt: 1,
  run_number: 3,
  status: 'completed',
};
/** A run after the verified base that ended without success. */
const laterRun = (id: number, conclusion: string): PriorRun => ({
  ...previousRun,
  conclusion,
  head_sha: EARLIER,
  id,
  run_number: id - 8,
});
/** Files the reference graph reaches from the units, the app host, the migrator and the delivery commands. */
const READ_BY_SERVICES = new Set([
  'app/scripts/run-zerops-migrator.mjs',
  'app/scripts/demo/seed-at-boot.mts',
  'app/tsconfig.base.json',
  'app/scripts/ops/stage-warmup.mts',
]);
const inputs: DeliveryInputs = {
  comparison: { ancestor: true, base: OLD, changedPaths: [], truncated: false },
  deliveryReads: READ_BY_SERVICES,
  forceFull: false,
  head: HEAD,
  mutations: [],
  packages,
  previousRuns: [previousRun],
  runAttempt: 1,
  runNumber: 20,
  units,
};
const planPaths = (changedPaths: readonly string[]) =>
  planDelivery({ ...inputs, comparison: { ancestor: true, base: OLD, changedPaths, truncated: false } });

it.effect('deploys both storefront services without building or redeploying the app for storefront-only input', () =>
  Effect.gen(function* storefrontOnly() {
    const plan = yield* planPaths([STOREFRONT_PAGE]);
    expect(plan.services).toEqual(['storefront', 'shop']);
    expect(plan.affectedUnits).toEqual([]);
    expect(plan.base).toBe(OLD);
    expect(plan.unverifiedRuns).toEqual([]);
  }),
);
it.effect('deploys only the N1 service for N1-storefront input', () =>
  Effect.gen(function* n1Only() {
    const plan = yield* planPaths([N1_PAGE]);
    expect(plan.full).toBe(false);
    expect(plan.services).toEqual(['n1']);
    expect(plan.affectedUnits).toEqual([]);
  }),
);
it.effect('keeps a storefront test or document selecting its storefront: Tailwind scans the whole package', () =>
  Effect.gen(function* storefrontTests() {
    expect((yield* planPaths(['app/n1-storefront/tests/cart-stock-ui.test.tsx'])).services).toEqual(['n1']);
    expect((yield* planPaths(['app/akros-storefront/src/app/page.test.tsx'])).services).toEqual(['storefront', 'shop']);
  }),
);
it.effect('deploys app-only owner changes without either unchanged storefront', () =>
  Effect.gen(function* appOnly() {
    const plan = yield* planPaths(['app/verticals/crm/src/search/clients.provider.ts']);
    expect(plan.services).toEqual(['app']);
    expect(plan.affectedUnits).toEqual(['crm']);
  }),
);
it.effect('deploys nothing for a docs-only release', () =>
  Effect.gen(function* documentationOnly() {
    const plan = yield* planPaths(['README.md', 'docs/design.json', 'app/docs/architecture/DEPLOYMENT.md']);
    expect(plan.services).toEqual([]);
    expect(plan.full).toBe(false);
  }),
);
it.effect('uses the last verified input base across skipped commits rather than HEAD parent', () =>
  Effect.gen(function* skippedCommitRange() {
    const plan = yield* planPaths(['docs/one.md', 'app/akros-storefront/src/new.ts', 'docs/two.md']);
    expect(plan.base).toBe(OLD);
    expect(plan.services).toEqual(['storefront', 'shop']);
  }),
);
for (const filepath of [
  '.github/workflows/ultramodern-workspace-gates.yml',
  '.github/workflows/quality-audit.yml',
  'app/scripts/ci/integration-seed.mts',
  'app/scripts/tests/ci-workflows.test.mts',
  'app/scripts/zerops/delivery-plan.test.mts',
  'app/scripts/lint-suppression-ratchet.mts',
  'app/tools/oxlint/rules/no-raw-sql.mjs',
  'app/quality-audit/suppressions.json',
  'app/oxlint.config.ts',
  'lefthook.yml',
  'app/tests/e2e/login.spec.ts',
]) {
  it.effect(`deploys nothing for ${filepath}, which no delivered service reads`, () =>
    Effect.gen(function* unreadInput() {
      const plan = yield* planPaths([filepath]);
      expect(plan.full).toBe(false);
      expect(plan.services).toEqual([]);
      expect(plan.affectedUnits).toEqual([]);
    }),
  );
}
for (const filepath of [
  'app/package.json',
  'app/pnpm-lock.yaml',
  'app/pnpm-workspace.yaml',
  'app/.mise.toml',
  'app/.npmrc',
  'app/patches/dependency.patch',
  'app/packages/shared-contracts/src/api.ts',
  'app/packages/shared-contracts/tests/api.test.ts',
  'app/topology/application-release-intent.json',
  'app/topology/reference-topology.json',
  'app/database/stage-roles.sql',
  'app/zerops.yaml',
  'app/zerops-import.yaml',
  'app/scripts/run-zerops-migrator.mjs',
  'app/scripts/demo/seed-at-boot.mts',
  'app/scripts/ops/stage-warmup.mts',
  'app/tsconfig.base.json',
  'app/scripts/zerops/owner-entry.mts',
  'app/scripts/zerops/app-runtime-excluded-packages.txt',
  'app/scripts/zerops/hosted-credential-claim.mts',
  'app/scripts/zerops/hosted-credential-claim-proof.mts',
  '.github/workflows/zerops-stage.yml',
  '.github/actions/install-app/action.yml',
  'app/verticals/crm/shared/api.ts',
  'app/verticals/not-yet-hosted/src/new.ts',
  'unknown-build-input.json',
  'app/verticals/crm/shared/contract.md',
]) {
  it.effect(`fails closed to all services and units for ${filepath}`, () =>
    Effect.gen(function* sharedInput() {
      const plan = yield* planPaths([filepath]);
      expect(plan.full).toBe(true);
      expect(plan.services).toEqual(ALL);
      expect(plan.affectedUnits).toEqual(['crm', 'merchandise', SHELL_ID]);
      expect(plan.reasons.join('\n')).toContain(filepath);
    }),
  );
}
for (const filepath of [
  'app/verticals/crm/drizzle/0001_expand.sql',
  'app/verticals/crm/drizzle.config.ts',
  'app/verticals/crm/src/database/schema.ts',
  'app/verticals/crm/scripts/verify-db-schema.mts',
]) {
  it.effect(`includes the app migration path ${filepath}`, () =>
    Effect.gen(function* ownerMigration() {
      const plan = yield* planPaths([filepath]);
      expect(plan.services).toEqual(['app']);
      expect(plan.migrations).toEqual([filepath]);
      expect(plan.affectedUnits).toEqual(['crm']);
    }),
  );
}
const mutation = (runId: number, mutated: boolean | null, services: RunMutation['services']): RunMutation => ({
  mutated,
  runId,
  services,
});
for (const [name, override] of [
  ['no earlier run', { previousRuns: [] }],
  ['no successful earlier run', { previousRuns: [{ ...previousRun, conclusion: 'failure' }] }],
  ['an unreadable comparison', { comparison: null }],
  [
    'a comparison against another base',
    { comparison: { ancestor: true, base: EARLIER, changedPaths: [], truncated: false } },
  ],
  ['a non-ancestor base', { comparison: { ancestor: false, base: OLD, changedPaths: [], truncated: false } }],
  [
    'a change list that may be cut short',
    { comparison: { ancestor: true, base: OLD, changedPaths: [], truncated: true } },
  ],
  ['a dispatch', { forceFull: true }],
  ['a re-run attempt', { runAttempt: 2 }],
  [
    'a later run that has not ended',
    { previousRuns: [previousRun, { ...laterRun(12, 'failure'), conclusion: null, status: 'in_progress' }] },
  ],
  [
    'a later failed run whose jobs could not be read',
    { mutations: [mutation(12, null, null)], previousRuns: [previousRun, laterRun(12, 'failure')] },
  ],
  ['a later failed run missing from the mutation list', { previousRuns: [previousRun, laterRun(12, 'failure')] }],
  [
    'a later run that changed stage without a readable plan',
    { mutations: [mutation(12, true, null)], previousRuns: [previousRun, laterRun(12, 'cancelled')] },
  ],
] as const) {
  it.effect(`falls back to full delivery for ${name}`, () =>
    Effect.gen(function* unsafeBaseline() {
      const plan = yield* planDelivery({ ...inputs, ...override });
      expect(plan.full).toBe(true);
      expect(plan.services).toEqual(ALL);
      expect(plan.reasons.length).toBeGreaterThan(0);
    }),
  );
}
it.effect('ignores a later run that was cancelled before any mutation', () =>
  Effect.gen(function* cancelledBeforeMutation() {
    const plan = yield* planDelivery({
      ...inputs,
      comparison: { ancestor: true, base: OLD, changedPaths: [N1_PAGE], truncated: false },
      mutations: [mutation(12, false, null)],
      previousRuns: [previousRun, laterRun(12, 'cancelled')],
    });
    expect(plan.full).toBe(false);
    expect(plan.services).toEqual(['n1']);
    expect(plan.unverifiedRuns).toEqual([]);
  }),
);
it.effect('redeploys the services of a later run that changed stage without being verified, and only those', () =>
  Effect.gen(function* unverifiedMutation() {
    const plan = yield* planDelivery({
      ...inputs,
      comparison: { ancestor: true, base: OLD, changedPaths: [N1_PAGE], truncated: false },
      mutations: [mutation(13, true, ['storefront', 'shop']), mutation(12, false, null)],
      previousRuns: [previousRun, laterRun(12, 'cancelled'), laterRun(13, 'failure')],
    });
    expect(plan.full).toBe(false);
    expect(plan.services).toEqual(['storefront', 'shop', 'n1']);
    expect(plan.unverifiedRuns).toEqual([13]);
    expect(plan.affectedUnits).toEqual([]);
  }),
);
it.effect('keeps a CI-only change selecting nothing after a later run that changed nothing', () =>
  Effect.gen(function* ciOnlyAfterCancel() {
    const plan = yield* planDelivery({
      ...inputs,
      comparison: {
        ancestor: true,
        base: OLD,
        changedPaths: ['.github/workflows/ultramodern-workspace-gates.yml', 'app/scripts/tests/ci-workflows.test.mts'],
        truncated: false,
      },
      mutations: [mutation(12, false, null)],
      previousRuns: [previousRun, laterRun(12, 'cancelled')],
    });
    expect(plan.services).toEqual([]);
  }),
);
it('takes the newest successful earlier run of this workflow and branch as the base', () => {
  const later = { ...previousRun, head_sha: EARLIER, id: 13, run_number: 5 };
  expect(previousVerifiedBase([previousRun, later], 6)?.head_sha).toBe(EARLIER);
  // A newer failed run does not hide the newest successful one; its mutations decide what deploys again.
  expect(previousVerifiedBase([previousRun, laterRun(14, 'failure')], 7)?.head_sha).toBe(OLD);
  // Never this run or a later one, another branch, or another workflow.
  expect(previousVerifiedBase([later], 5)).toBeNull();
  expect(previousVerifiedBase([{ ...later, head_branch: 'other' }], 6)).toBeNull();
  expect(previousVerifiedBase([{ ...later, path: '.github/workflows/other.yml' }], 6)).toBeNull();
});
it('names the mutation marker the workflow places before every secret sync and push', () => {
  expect(MUTATION_MARKER).toBe('Mark the actual deployment attempt');
});
it.effect('includes transitive consumers and handles dependency cycles without duplicating units', () =>
  Effect.gen(function* consumerClosure() {
    const graph = packages.map((entry) =>
      entry.name === SHELL_PACKAGE ? { ...entry, workspaceDependencies: [CRM_PACKAGE] } : entry,
    );
    const plan = yield* planDelivery({
      ...inputs,
      comparison: { ancestor: true, base: OLD, changedPaths: [CRM_ENTRY], truncated: false },
      packages: graph,
    });
    expect(plan.affectedUnits).toEqual(['crm', SHELL_ID]);
    const cycle = graph.map((entry) =>
      entry.name === CRM_PACKAGE ? { ...entry, workspaceDependencies: [SHELL_PACKAGE] } : entry,
    );
    expect(yield* workspaceClosure(SHELL_DIRECTORY, cycle)).toEqual([SHELL_DIRECTORY, CRM_DIRECTORY]);
  }),
);
it.effect('includes storefronts if a future workspace dependency actually consumes the changed owner', () =>
  Effect.gen(function* futureStorefrontDependency() {
    const graph = packages.map((entry) =>
      entry.name === 'akros-storefront' ? { ...entry, workspaceDependencies: [CRM_PACKAGE] } : entry,
    );
    const plan = yield* planDelivery({
      ...inputs,
      comparison: { ancestor: true, base: OLD, changedPaths: [CRM_ENTRY], truncated: false },
      packages: graph,
    });
    expect(plan.services).toEqual(['app', 'storefront', 'shop']);
  }),
);
it.effect('refuses unresolved dependency graphs instead of inventing unchanged inputs', () =>
  Effect.gen(function* unresolvedWorkspaceDependency() {
    const exit = yield* workspaceClosure('app/missing', packages).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);
