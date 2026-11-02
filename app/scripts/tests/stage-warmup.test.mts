import { Effect, Exit, Ref } from 'effect';
import { expect, it } from 'effect-rstest';

import { demoTenantId } from '../demo/fixture-ids.mts';
import { demoCompanyMemberships, principalRelationships } from '../demo/permissions.mts';
import { warmupAccounts } from '../demo/warmup-accounts.mts';
import { stageWarmupRelationships } from '../demo/seed-stage-warmup.mts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { warmupRequestAllowed, WARMUP_BUDGET_MS } from '../ops/stage-warmup.mts';
import { checkStageVisibleText } from '../ops/stage-visible-text.mts';
import { createOwnerWarmState } from '../zerops/owner-warm-state.mts';
import { observeFirstSpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-client-observability.ts';

const taskOwner = 'work-tasks';

it.effect('fails stage verification for rendered identifiers while allowing human business codes', () =>
  Effect.gen(function* visibleTextGuard() {
    const rejected = yield* Effect.exit(
      checkStageVisibleText('/cs/prodej/zakaznici', 'Subjekt fbdd110f-e514-53e9-9832-20f6e4cb1f9d'),
    );
    expect(Exit.isFailure(rejected)).toBe(true);
    yield* checkStageVisibleText('/cs/prodej/objednavky', 'OBJ-2026-0009 · IČO 25741136 · SKU AKROS_001 · R301');
  }),
);

it('seeds one clearly named external reader per demo company, without inherited administrators or write grants', () => {
  expect(warmupAccounts).toHaveLength(5);
  expect(new Set(warmupAccounts.map(({ legalEntityId }) => legalEntityId)).size).toBe(5);
  const sales = warmupAccounts.find(({ company }) => company === 'obchod');
  const rental = warmupAccounts.find(({ company }) => company === 'najempark');
  expect(sales?.role.modules).toMatchObject({ 'property.leasing': 'read', 'property.portfolio': 'read' });
  expect(Object.keys(rental?.role.modules ?? {})).not.toContain('crm.activities');
  expect(Object.keys(rental?.role.modules ?? {})).not.toContain('demo.merchandise');
  for (const account of warmupAccounts) {
    expect(account.email).toBe(`warmup@${account.company}.demo`);
    expect(Object.values(account.role.modules).every((access) => access === 'read')).toBe(true);
    expect(demoCompanyMemberships.filter((row) => row.principalId === account.principalId)).toEqual([
      { affiliation: 'external', legalEntityId: account.legalEntityId, principalId: account.principalId },
    ]);
    const grants = principalRelationships(
      account.principalId,
      account.role,
      [
        {
          actionKey: 'work.tasks.apply-command',
          legalEntityScope: 'required',
          owningModuleKey: 'work.tasks',
          provisioning: 'explicit',
        },
      ],
      account.legalEntityId,
      demoTenantId,
      account.roleKey,
    );
    expect(grants.some(({ resourceType }) => resourceType === 'action' || resourceType === 'action_grant')).toBe(false);
    expect(grants.some(({ relation }) => ['admin', 'superadmin', 'executor', 'writer'].includes(relation))).toBe(false);
    const stageGrants = stageWarmupRelationships(account);
    expect(
      stageGrants.filter(({ resourceType, subjectType }) => resourceType === 'tenant' && subjectType === 'principal'),
    ).toEqual([
      {
        relation: 'company_member',
        resourceId: demoTenantId,
        resourceType: 'tenant',
        subjectId: account.principalId,
        subjectType: 'principal',
      },
    ]);
    expect(stageGrants.some(({ resourceType }) => resourceType === 'action' || resourceType === 'action_grant')).toBe(
      false,
    );
  }
});

it('allows only local read/authentication traffic and blocks Actions, arbitrary POSTs and other origins', () => {
  const origin = 'https://ontos-stage.web-revolution.cz';
  expect(WARMUP_BUDGET_MS).toBeLessThanOrEqual(90_000);
  expect(warmupRequestAllowed('GET', `${origin}/_m/work-tasks/mf-manifest.json`)).toBe(true);
  expect(warmupRequestAllowed('POST', `${origin}/shell-super-app-api/auth/sign-in`)).toBe(true);
  expect(
    warmupRequestAllowed('POST', `${origin}/shell-super-app-api/module-api/work-tasks/abcd/api/reads/records`),
  ).toBe(true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    expect(
      warmupRequestAllowed(method, `${origin}/shell-super-app-api/module-api/work-tasks/abcd/api/actions/apply`),
    ).toBe(false);
  }
  expect(warmupRequestAllowed('GET', 'https://example.com/asset.js')).toBe(false);
  expect(warmupRequestAllowed('POST', `${origin}/shell-super-app-api/auth/delete-user`)).toBe(false);
});

it('keeps first request/read timing and SSR import counters per owner without mistaking assets for SSR', () => {
  const state = createOwnerWarmState();
  state.register(taskOwner);
  state.request(taskOwner, '/mf-manifest.json?secret=not-retained', 100)?.(2.123);
  state.request(taskOwner, '/api/reads/records', 200)?.(8.126);
  state.request(taskOwner, '/api/reads/records', 300)?.(99);
  expect(state.snapshot()).toEqual([
    {
      firstReadAt: 200,
      firstReadDurationMs: 8.13,
      firstRequestAt: 100,
      firstRequestDurationMs: 2.12,
      firstRequestPath: '/mf-manifest.json',
      owner: taskOwner,
      requests: 3,
      ssrBundleFailures: 0,
      ssrBundleLoads: 0,
      ssrBundleTotalMs: 0,
    },
  ]);
  state.bundle(taskOwner, {
    durationMs: 14,
    filepath: '/verticals/work-tasks/dist/bundles/index.js',
    outcome: 'loaded',
    triggerPath: '/document',
  });
  expect(state.snapshot()[0]?.ssrBundleLoads).toBe(1);
});

it.effect('reports the first SpiceDB RPC exactly once, including a failing first call', () =>
  Effect.gen(function* firstRpc() {
    const samples: string[] = [];
    const previousObserver = globalThis.ontosSpiceDbClientObserver;
    const previousStarted = globalThis.ontosSpiceDbFirstRpcStarted;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        globalThis.ontosSpiceDbFirstRpcStarted = Ref.makeUnsafe(false);
        globalThis.ontosSpiceDbClientObserver = (sample) => {
          samples.push(`${sample.method}:${sample.outcome}`);
        };
      }),
      () =>
        Effect.sync(() => {
          globalThis.ontosSpiceDbClientObserver = previousObserver;
          globalThis.ontosSpiceDbFirstRpcStarted = previousStarted;
        }),
    );
    yield* Effect.fail('unavailable').pipe(observeFirstSpiceDbRpc('checkPermission'), Effect.exit);
    yield* Effect.void.pipe(observeFirstSpiceDbRpc('readSchema'));
    expect(samples).toEqual(['checkPermission:failure']);
  }).pipe(Effect.scoped),
);

it.effect(
  'gives the standalone warm-up seed a scoped process pool registry and releases it on success or failure',
  () =>
    Effect.gen(function* operatorPoolLifecycle() {
      expect(globalThis.ontosDatabasePoolRegistry).toBeUndefined();
      yield* Effect.sync(() => {
        expect(globalThis.ontosDatabasePoolRegistry).toBeDefined();
      }).pipe(Effect.provide(ProcessDatabasePoolsLive));
      expect(globalThis.ontosDatabasePoolRegistry).toBeUndefined();
      yield* Effect.fail('operator stopped').pipe(Effect.provide(ProcessDatabasePoolsLive), Effect.exit);
      expect(globalThis.ontosDatabasePoolRegistry).toBeUndefined();
    }),
);
