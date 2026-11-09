import { loadDatabaseConnectionPair, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Deferred, Duration, Effect, Fiber, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import {
  SymmyJobRetentionPolicySchema,
  symmyJobIntentContentRef,
  symmyJobResourceRef,
} from '../../shared/domain/symmy-job-retention.ts';
import {
  symmyImportJobs,
  symmyIntegrationRelations,
  symmyJobEffects,
  symmyJobNotifications,
  symmyJobPrivacyExecutions,
  symmyJobRetentionTombstones,
  symmyJobRoutes,
} from '../../src/db/schema.ts';
import { symmyJobStoreFactory } from '../../src/persistence/symmy-job-store.ts';
import { symmyJobPrivacyExecutionStore } from '../../src/services/symmy-job-privacy-execution-store.ts';
import type { SymmyJobPrivacyExecutionRecord } from '../../src/services/symmy-job-privacy-execution-store.ts';
import { symmyJobRetentionStore } from '../../src/services/symmy-job-retention-store.ts';

const fixture = Effect.gen(function* nativeReceiptFixture() {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const admin = yield* PgClient.makeClient({ url: Redacted.make(connections.admin.connectionString) });
  const first = yield* PgClient.makeClient({ url: Redacted.make(connections.runtime.connectionString) });
  const second = yield* PgClient.makeClient({ url: Redacted.make(connections.runtime.connectionString) });
  const adminDb = yield* makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(
    Effect.provideService(PgClient.PgClient, admin),
  );
  const firstDb = yield* makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(
    Effect.provideService(PgClient.PgClient, first),
  );
  const secondDb = yield* makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(
    Effect.provideService(PgClient.PgClient, second),
  );
  const tenantId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const routeId = crypto.randomUUID();
  const scope: OperationalScope = {
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: crypto.randomUUID(),
      authContextRef: 'better-auth-api-key:internal-privacy-receipt',
      authMethod: 'api_key',
      principalId,
      tenantId,
    }),
    audience: 'symmy-integration',
    correlationId: 'internal-privacy-receipt',
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* cleanup() {
      yield* adminDb.delete(symmyJobPrivacyExecutions).where(eq(symmyJobPrivacyExecutions.tenantId, tenantId));
      yield* adminDb.delete(symmyJobRetentionTombstones).where(eq(symmyJobRetentionTombstones.tenantId, tenantId));
      yield* adminDb.delete(symmyJobNotifications).where(eq(symmyJobNotifications.tenantId, tenantId));
      yield* adminDb.delete(symmyJobEffects).where(eq(symmyJobEffects.tenantId, tenantId));
      yield* adminDb.delete(symmyImportJobs).where(eq(symmyImportJobs.tenantId, tenantId));
      yield* adminDb.delete(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, tenantId));
    }).pipe(Effect.orDie),
  );
  const plan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'catalog',
            operation: {
              entrypointKey: 'commerce.catalog.create-product',
              moduleId: 'commerce.catalog',
              schemaVersion: '1',
            },
          },
        ],
        itemKey: 'internal-row',
        source: {
          entityKind: 'PRODUCT',
          issuerId: 'internal-issuer',
          sourceNamespace: 'internal-space',
          sourceRecordId: 'internal-record',
        },
      },
    ],
  });
  yield* adminDb.insert(symmyJobRoutes).values({
    active: true,
    fixtureIds: ['internal-privacy-receipt'],
    fixturePlan: plan,
    lifecyclePolicy: { policyId: 'receipt-retention', revision: 'v1' },
    mappingVersion: 'v1',
    principalId,
    routeId,
    routeKey: 'productsBatch',
    routeRevision: 'v1',
    tenantId,
  });
  const admitted = yield* firstDb.transaction((tx) =>
    installOperationalScope(tx, scope).pipe(
      Effect.flatMap((executor) => symmyJobStoreFactory(executor, scope)),
      Effect.flatMap((store) =>
        store.admit({
          fixtureId: 'internal-privacy-receipt',
          idempotencyKey: 'internal-privacy-receipt',
          routeKey: 'productsBatch',
        }),
      ),
    ),
  );
  const policy = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema)({
    governanceLegalEntityId: crypto.randomUUID(),
    policyId: 'receipt-retention',
    retentionMs: 1,
    revision: 'v1',
    routeId,
    targetLegalEntityId: null,
    tenantId,
  });
  const governanceScope = { ...scope, legalEntityId: policy.governanceLegalEntityId };
  const purgeInput = {
    authority: {
      authorityReceiptRef: 'internal-approved-disposition',
      authorityRevision: '1',
      contentScopeRef: symmyJobIntentContentRef(admitted.jobId),
      resourceRef: symmyJobResourceRef(admitted.jobId),
      status: 'CURRENT_APPROVED' as const,
    },
    jobId: admitted.jobId,
    policy,
  };
  return {
    admin,
    adminDb,
    first,
    firstDb,
    governanceScope,
    jobId: admitted.jobId,
    purgeInput,
    scope,
    second,
    secondDb,
  };
});

const receiptFor = (
  state: Effect.Success<typeof fixture>,
  attempt: number,
  status: 'BLOCKED' | 'SUCCEEDED',
): SymmyJobPrivacyExecutionRecord => {
  const receiptId = crypto.randomUUID();
  const resourceRef = symmyJobResourceRef(state.jobId);
  return {
    actionInvocationId: crypto.randomUUID(),
    actorPrincipalId: state.scope.principalId,
    governanceLegalEntityId: state.governanceScope.legalEntityId,
    handoffFingerprint: 'b'.repeat(64),
    outcome: {
      attempt,
      evidenceRefs: [`integration.symmy.privacy-measure-execution:${receiptId}`],
      idempotencyKey: 'internal-privacy-receipt',
      includedResourceRefs: status === 'SUCCEEDED' ? [resourceRef] : [],
      measureId: 'internal-receipt-measure',
      occurredAt: '2026-11-07T00:00:00.000Z',
      outcomeId: receiptId,
      owningCapability: 'integration.symmy',
      reason: 'Internal owner persistence proof',
      recordedAt: '2026-11-07T00:00:00.000Z',
      remainingResourceRefs: status === 'BLOCKED' ? [resourceRef] : [],
      sourceDecisionRef: 'internal-receipt-decision',
      sourceDecisionRevision: 1,
      status,
      taskId: 'internal-receipt-task',
    },
    receiptId,
    resourceId: state.jobId,
    resourceKind: 'JOB',
    retentionStatus: status === 'SUCCEEDED' ? 'PURGED' : 'BLOCKED',
    targetLegalEntityId: null,
  };
};

it.effect(
  'keeps immutable exact-attempt receipts and refuses an unproved success, conflicting fingerprint and terminal downgrade',
  () =>
    Effect.gen(function* immutableReceipts() {
      // INTERNAL_CONTRACT: real owner routines and persistence only, not public Privacy authorization or native Action acceptance.
      const state = yield* fixture;
      const digest = 'a'.repeat(64);
      const blocked = receiptFor(state, 1, 'BLOCKED');
      const run = <A, E>(operation: (store: ReturnType<typeof symmyJobPrivacyExecutionStore>) => Effect.Effect<A, E>) =>
        state.firstDb.transaction((tx) =>
          installOperationalScope(tx, state.governanceScope).pipe(
            Effect.flatMap((executor) => operation(symmyJobPrivacyExecutionStore(executor))),
          ),
        );
      expect(Option.isNone(yield* run((store) => store.load(digest)))).toBe(true);
      expect(yield* run((store) => store.record(digest, receiptFor(state, 1, 'SUCCEEDED')))).toBe(false);
      expect(yield* run((store) => store.record(digest, blocked))).toBe(true);
      expect(
        yield* run((store) =>
          store.record(digest, { ...receiptFor(state, 2, 'BLOCKED'), handoffFingerprint: 'c'.repeat(64) }),
        ),
      ).toBe(false);
      expect(yield* run((store) => store.record(digest, receiptFor(state, 3, 'BLOCKED')))).toBe(false);
      expect(
        yield* state.firstDb.transaction((tx) =>
          installOperationalScope(tx, state.governanceScope).pipe(
            Effect.flatMap((executor) => symmyJobRetentionStore(executor).purge(state.purgeInput)),
          ),
        ),
      ).toBe('PURGED');
      const succeeded = receiptFor(state, 2, 'SUCCEEDED');
      expect(yield* run((store) => store.record(digest, succeeded))).toBe(true);
      expect(yield* run((store) => store.record(digest, receiptFor(state, 3, 'BLOCKED')))).toBe(false);
      expect(Option.getOrThrow(yield* run((store) => store.load(digest))).outcome).toEqual(succeeded.outcome);
      expect(Option.getOrThrow(yield* run((store) => store.load(digest, 1))).outcome).toEqual(blocked.outcome);
      expect(Option.getOrThrow(yield* run((store) => store.load(digest, 2))).outcome).toEqual(succeeded.outcome);
      expect(Option.isNone(yield* run((store) => store.load(digest, 3)))).toBe(true);
      const rows = yield* state.adminDb
        .select()
        .from(symmyJobPrivacyExecutions)
        .where(eq(symmyJobPrivacyExecutions.tenantId, state.scope.tenantId));
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain('internal-record');
      expect(rows.map(({ receiptId }) => receiptId)).toEqual(
        expect.arrayContaining([blocked.receiptId, succeeded.receiptId]),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);

it.effect('isolates receipt lookup and recording by the actual Tenant and Governance company scope', () =>
  Effect.gen(function* receiptScope() {
    const state = yield* fixture;
    const digest = 'a'.repeat(64);
    const blocked = receiptFor(state, 1, 'BLOCKED');
    expect(
      yield* state.firstDb.transaction((tx) =>
        installOperationalScope(tx, state.governanceScope).pipe(
          Effect.flatMap((executor) => symmyJobPrivacyExecutionStore(executor).record(digest, blocked)),
        ),
      ),
    ).toBe(true);
    const otherCompany = {
      ...state.governanceScope,
      legalEntityId: Schema.decodeUnknownSync(LegalEntityIdSchema)(crypto.randomUUID()),
    };
    expect(
      Option.isNone(
        yield* state.firstDb.transaction((tx) =>
          installOperationalScope(tx, otherCompany).pipe(
            Effect.flatMap((executor) => symmyJobPrivacyExecutionStore(executor).load(digest)),
          ),
        ),
      ),
    ).toBe(true);
    const wrongCompany = yield* state.firstDb
      .transaction((tx) =>
        installOperationalScope(tx, otherCompany).pipe(
          Effect.flatMap((executor) => symmyJobPrivacyExecutionStore(executor).record(digest, blocked)),
        ),
      )
      .pipe(Effect.flip);
    expect(wrongCompany).toMatchObject({ code: 'privacy_execution_unavailable' });
    const otherTenant: OperationalScope = {
      ...state.governanceScope,
      tenantId: Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: crypto.randomUUID(),
        authContextRef: 'better-auth-api-key:internal-other-receipt',
        authMethod: 'api_key',
        principalId: crypto.randomUUID(),
        tenantId: crypto.randomUUID(),
      }).tenantId,
    };
    expect(
      Option.isNone(
        yield* state.firstDb.transaction((tx) =>
          installOperationalScope(tx, otherTenant).pipe(
            Effect.flatMap((executor) => symmyJobPrivacyExecutionStore(executor).load(digest)),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      yield* state.firstDb.transaction((tx) =>
        installOperationalScope(tx, otherTenant).pipe(
          Effect.flatMap((executor) => symmyJobPrivacyExecutionStore(executor).record(digest, blocked)),
        ),
      ),
    ).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);

it.effect('serializes an absent first receipt across two actual transactions before either can create an attempt', () =>
  Effect.gen(function* firstReceiptRace() {
    const state = yield* fixture;
    const digest = 'a'.repeat(64);
    const firstReady = yield* Deferred.make<number>();
    const releaseFirst = yield* Deferred.make<boolean>();
    const secondReady = yield* Deferred.make<number>();
    const receipt = receiptFor(state, 1, 'BLOCKED');
    const firstFiber = yield* Effect.forkChild(
      state.firstDb.transaction((tx) =>
        Effect.gen(function* holdMissingReceipt() {
          const executor = yield* installOperationalScope(tx, state.governanceScope);
          const rows = yield* state.first<{ pid: number }>`select pg_backend_pid() as pid`;
          expect(Option.isNone(yield* symmyJobPrivacyExecutionStore(executor).lock(digest))).toBe(true);
          const pid = rows[0]?.pid;
          if (pid === undefined) {
            throw new Error('Expected first native backend');
          }
          yield* Deferred.succeed(firstReady, pid);
          yield* Deferred.await(releaseFirst);
          return yield* symmyJobPrivacyExecutionStore(executor).record(digest, receipt);
        }),
      ),
    );
    const firstPid = yield* Deferred.await(firstReady);
    const secondFiber = yield* Effect.forkChild(
      state.secondDb.transaction((tx) =>
        Effect.gen(function* observeCommittedReceipt() {
          const executor = yield* installOperationalScope(tx, state.governanceScope);
          const rows = yield* state.second<{ pid: number }>`select pg_backend_pid() as pid`;
          const pid = rows[0]?.pid;
          if (pid === undefined) {
            throw new Error('Expected second native backend');
          }
          yield* Deferred.succeed(secondReady, pid);
          const prior = yield* symmyJobPrivacyExecutionStore(executor).lock(digest);
          const duplicate = yield* symmyJobPrivacyExecutionStore(executor).record(
            digest,
            receiptFor(state, 1, 'BLOCKED'),
          );
          return { duplicate, prior };
        }),
      ),
    );
    const secondPid = yield* Deferred.await(secondReady);
    yield* Effect.gen(function* observeNativeBarrier() {
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = yield* state.admin<{
          blocked: boolean;
        }>`select ${firstPid}::integer=any(pg_blocking_pids(${secondPid}::integer)) as blocked`;
        if (rows[0]?.blocked) {
          blocked = true;
          break;
        }
        yield* TestClock.adjust(Duration.millis(1));
      }
      expect(blocked).toBe(true);
    }).pipe(Effect.ensuring(Deferred.succeed(releaseFirst, true)));
    const [firstResult, secondResult] = yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)], {
      concurrency: 2,
    });
    expect(firstResult).toBe(true);
    expect(secondResult.duplicate).toBe(false);
    expect(Option.getOrThrow(secondResult.prior).outcome).toEqual(receipt.outcome);
    expect(
      yield* state.adminDb
        .select()
        .from(symmyJobPrivacyExecutions)
        .where(eq(symmyJobPrivacyExecutions.tenantId, state.scope.tenantId)),
    ).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);
