import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  DeliveryReceiptSchema,
  planDelivery,
  previousVerifiedBase,
  unitInputDigest,
  workspaceClosure,
} from './delivery-plan.mts';
import type { DeliveryInputs, DeliveryReceipt, GitEntry, WorkspacePackage } from './delivery-plan.mts';

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
const previousReceipt: DeliveryReceipt = {
  lastAttempt: { runAttempt: 1, runId: 11, sourceRevision: OLD },
  runAttempt: 1,
  runId: 11,
  schemaVersion: 1,
  services: { app: OLD, shop: EARLIER, storefront: EARLIER },
  validatedHead: OLD,
};
const previousRun = {
  conclusion: 'success',
  head_branch: 'demo/sales-crm',
  head_sha: OLD,
  id: 11,
  path: '.github/workflows/zerops-stage.yml',
  run_attempt: 1,
  run_number: 3,
  status: 'completed',
};
const inputs: DeliveryInputs = {
  ancestor: true,
  changedPaths: [],
  forceFull: false,
  head: HEAD,
  packages,
  previousAttempt: { runAttempt: 1, runId: 11, sourceRevision: OLD },
  previousReceipt,
  previousRuns: [previousRun],
  runAttempt: 1,
  runId: 12,
  runNumber: 4,
  units,
};
const planPaths = (changedPaths: readonly string[]) => planDelivery({ ...inputs, changedPaths });

it.effect('deploys both storefront services without building or redeploying the app for storefront-only input', () =>
  Effect.gen(function* storefrontOnly() {
    const plan = yield* planPaths([STOREFRONT_PAGE]);
    expect(plan.services).toEqual(['storefront', 'shop']);
    expect(plan.affectedUnits).toEqual([]);
    expect(plan.receipt.services).toEqual({ app: OLD, shop: HEAD, storefront: HEAD });
    expect(plan.receipt.validatedHead).toBe(HEAD);
    expect(plan.receipt.lastAttempt).toEqual({ runAttempt: 1, runId: 12, sourceRevision: HEAD });
  }),
);
it.effect('deploys only the N1 service for N1-storefront input and keeps every other pin', () =>
  Effect.gen(function* n1Only() {
    const plan = yield* planPaths(['app/n1-storefront/src/app/page.tsx']);
    expect(plan.full).toBe(false);
    expect(plan.services).toEqual(['n1']);
    expect(plan.affectedUnits).toEqual([]);
    expect(plan.receipt.services).toEqual({ app: OLD, n1: HEAD, shop: EARLIER, storefront: EARLIER });
    expect(Schema.is(DeliveryReceiptSchema)(plan.receipt)).toBe(true);
  }),
);
it('accepts receipts written before the N1 service had a pin', () => {
  expect(Schema.is(DeliveryReceiptSchema)(previousReceipt)).toBe(true);
});
it.effect('deploys app-only owner changes without either unchanged storefront', () =>
  Effect.gen(function* appOnly() {
    const plan = yield* planPaths(['app/verticals/crm/src/search/clients.provider.ts']);
    expect(plan.services).toEqual(['app']);
    expect(plan.affectedUnits).toEqual(['crm']);
    expect(plan.receipt.services).toEqual({ app: HEAD, shop: EARLIER, storefront: EARLIER });
  }),
);
it.effect('keeps all actual service pins for a docs-only/no-op release', () =>
  Effect.gen(function* documentationOnly() {
    const plan = yield* planPaths(['README.md', 'docs/design.json', 'app/docs/architecture/DEPLOYMENT.md']);
    expect(plan.services).toEqual([]);
    expect(plan.receipt.services).toEqual(previousReceipt.services);
    expect(plan.receipt.validatedHead).toBe(HEAD);
    expect(plan.receipt.lastAttempt).toEqual(previousReceipt.lastAttempt);
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
  'app/package.json',
  'app/pnpm-lock.yaml',
  'app/pnpm-workspace.yaml',
  'app/.mise.toml',
  'app/.npmrc',
  'app/patches/dependency.patch',
  'app/packages/shared-contracts/src/api.ts',
  'app/topology/application-release-intent.json',
  'app/topology/reference-topology.json',
  'app/zerops.yaml',
  'app/scripts/install-zerops-node.sh',
  'app/scripts/run-zerops-migrator.mjs',
  'app/scripts/zerops/owner-entry.mts',
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
      expect(plan.services).toEqual(['app', 'storefront', 'shop', 'n1']);
      expect(plan.affectedUnits).toEqual(['crm', 'merchandise', SHELL_ID]);
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
for (const override of [
  { previousReceipt: null },
  { previousAttempt: null },
  { previousAttempt: { runAttempt: 2, runId: 11, sourceRevision: OLD } },
  { previousAttempt: { runAttempt: 1, runId: 1, sourceRevision: HEAD } },
  { previousRuns: [] },
  { previousRuns: [{ ...previousRun, conclusion: 'failure' }] },
  { previousRuns: [{ ...previousRun, conclusion: 'cancelled' }] },
  { previousRuns: [{ ...previousRun, conclusion: null, status: 'in_progress' }] },
  { previousRuns: [{ ...previousRun, run_attempt: 2 }] },
  { previousReceipt: { ...previousReceipt, runId: 99 } },
  { ancestor: false },
  { forceFull: true },
  { runAttempt: 2 },
]) {
  it.effect(`falls back to full delivery for unsafe prior release ${JSON.stringify(override)}`, () =>
    Effect.gen(function* unsafeBaseline() {
      const plan = yield* planDelivery({ ...inputs, ...override });
      expect(plan.full).toBe(true);
      expect(plan.services).toEqual(['app', 'storefront', 'shop', 'n1']);
    }),
  );
}
it('does not jump over a newer failed run to use an older successful release', () => {
  expect(
    previousVerifiedBase(
      previousReceipt,
      [previousRun, { ...previousRun, conclusion: 'failure', id: 13, run_number: 4 }],
      5,
    ),
  ).toBeNull();
});
it.effect('forces full recovery after an old rerun failed outside the bounded workflow history page', () =>
  Effect.gen(function* failedOlderAttempt() {
    const plan = yield* planDelivery({
      ...inputs,
      changedPaths: [STOREFRONT_PAGE],
      previousAttempt: { runAttempt: 2, runId: 1, sourceRevision: EARLIER },
    });
    expect(plan.services).toEqual(['app', 'storefront', 'shop', 'n1']);
    expect(plan.full).toBe(true);
  }),
);
it('ignores another branch/workflow but does not ignore its own failed attempt', () => {
  expect(
    previousVerifiedBase(
      previousReceipt,
      [previousRun, { ...previousRun, head_branch: 'other', id: 13, run_number: 4 }],
      5,
    ),
  ).toBe(OLD);
});
it('rejects a receipt with an invented or workspace source pin', () => {
  expect(
    Schema.is(DeliveryReceiptSchema)({
      ...previousReceipt,
      services: { ...previousReceipt.services, app: 'workspace' },
    }),
  ).toBe(false);
});
it.effect('includes transitive consumers and handles dependency cycles without duplicating units', () =>
  Effect.gen(function* consumerClosure() {
    const graph = packages.map((entry) =>
      entry.name === SHELL_PACKAGE ? { ...entry, workspaceDependencies: [CRM_PACKAGE] } : entry,
    );
    const plan = yield* planDelivery({ ...inputs, changedPaths: [CRM_ENTRY], packages: graph });
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
    const plan = yield* planDelivery({ ...inputs, changedPaths: [CRM_ENTRY], packages: graph });
    expect(plan.services).toEqual(['app', 'storefront', 'shop']);
  }),
);
it.effect('refuses unresolved dependency graphs instead of inventing unchanged inputs', () =>
  Effect.gen(function* unresolvedWorkspaceDependency() {
    const exit = yield* workspaceClosure('app/missing', packages).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

const origins = ['https://shell.example', 'https://storefront.example', 'https://shop.example'];
const entry = (filepath: string, identity = OLD): GitEntry => ({ identity, path: filepath });
const digest = (entries: readonly GitEntry[]) => unitInputDigest(CRM_DIRECTORY, packages, units, entries, origins);
it.effect('keeps a unit cache only when its real committed input closure is unchanged', () =>
  Effect.gen(function* cacheDependencyClosure() {
    const first = entry(CRM_ENTRY);
    const second = entry('app/verticals/merchandise/api/index.ts');
    const baseline = [first, second];
    const initial = yield* digest(baseline);
    expect(yield* digest([first, entry(second.path, HEAD)])).toBe(initial);
    expect(yield* digest([entry(first.path, HEAD), second])).not.toBe(initial);
    expect(yield* digest([...baseline, entry(STOREFRONT_PAGE)])).toBe(initial);
    expect(yield* digest([...baseline, entry('app/n1-storefront/src/app/page.tsx')])).toBe(initial);
    expect(yield* digest([...baseline, entry('docs/README.md')])).toBe(initial);
    for (const filepath of [
      'app/packages/shared-contracts/src/api.ts',
      'app/package.json',
      'app/pnpm-lock.yaml',
      'app/.mise.toml',
      'app/scripts/install-zerops-node.sh',
      'app/scripts/run-zerops-migrator.mjs',
      'app/topology/application-release-intent.json',
      'app/unknown-input.ts',
      'app/verticals/merchandise/shared/api.ts',
    ]) {
      expect(yield* digest([...baseline, entry(filepath)])).not.toBe(initial);
    }
    expect(yield* digest([])).not.toBe(initial);
    expect(yield* unitInputDigest(CRM_DIRECTORY, packages, units, baseline, [...origins, 'changed'])).not.toBe(initial);
  }),
);
