import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { FetchHttpClient } from 'effect/http';
import { SymmyJobPrivacy } from '../../src/services/symmy-job-privacy.service.ts';
import { symmyJobRetentionService } from '../../src/services/symmy-job-retention.service.ts';
import { TestClock } from 'effect/testing';
import { SymmyEffectIdSchema } from '@app/shared-contracts/symmy';
import { loadDatabaseConnectionPair, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { ConfigProvider, Deferred, Duration, Effect, Fiber, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
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
  symmyJobRetentionTombstones,
  symmyJobRoutes,
} from '../../src/db/schema.ts';
import { symmyJobExecutionStore } from '../../src/persistence/symmy-job-execution-store.ts';
import { symmyJobStoreFactory } from '../../src/persistence/symmy-job-store.ts';
import { symmyJobRetentionStore } from '../../src/services/symmy-job-retention-store.ts';

const pidSchema = Schema.Tuple([Schema.Struct({ pid: Schema.Int })]);
const fixture = Effect.gen(function* nativeRaceFixture() {
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
      authContextRef: 'better-auth-api-key:internal-retention-race',
      authMethod: 'api_key',
      principalId,
      tenantId,
    }),
    audience: 'symmy-integration',
    correlationId: 'internal-retention-race',
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* cleanup() {
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
    fixtureIds: ['internal-race'],
    fixturePlan: plan,
    lifecyclePolicy: { policyId: 'race-retention', revision: 'v1' },
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
        store.admit({ fixtureId: 'internal-race', idempotencyKey: 'internal-race', routeKey: 'productsBatch' }),
      ),
    ),
  );
  const effects = yield* adminDb
    .select({ effectId: symmyJobEffects.effectId })
    .from(symmyJobEffects)
    .where(eq(symmyJobEffects.jobId, admitted.jobId));
  const [effect] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ effectId: SymmyEffectIdSchema })]))(
    effects,
  );
  const policy = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema)({
    governanceLegalEntityId: crypto.randomUUID(),
    policyId: 'race-retention',
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
    effectId: effect.effectId,
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

for (const order of ['CLAIM_FIRST', 'PURGE_FIRST'] as const) {
  it.effect(`serializes native ${order} with an independently blocked connection`, () =>
    Effect.gen(function* verifyRace() {
      // INTERNAL_CONTRACT owner persistence proof: both connections invoke real scoped production routines.
      const state = yield* fixture;
      const firstReady = yield* Deferred.make<number>();
      const releaseFirst = yield* Deferred.make<boolean>();
      const secondReady = yield* Deferred.make<number>();
      const token = crypto.randomUUID();
      const firstFiber = yield* Effect.forkChild(
        state.firstDb.transaction((tx) =>
          Effect.gen(function* firstTransaction() {
            const executor = yield* installOperationalScope(
              tx,
              order === 'CLAIM_FIRST' ? state.scope : state.governanceScope,
            );
            const [pid] = yield* Schema.decodeUnknownEffect(pidSchema)(
              yield* state.first<{ pid: number }>`select pg_backend_pid() as pid`,
            );
            const result =
              order === 'CLAIM_FIRST'
                ? yield* symmyJobExecutionStore(executor).claim(state.jobId, state.effectId, token)
                : yield* symmyJobRetentionStore(executor).purge(state.purgeInput);
            yield* Deferred.succeed(firstReady, pid.pid);
            yield* Deferred.await(releaseFirst);
            return result;
          }),
        ),
      );
      const firstPid = yield* Deferred.await(firstReady);
      const secondFiber = yield* Effect.forkChild(
        state.secondDb.transaction((tx) =>
          Effect.gen(function* secondTransaction() {
            const executor = yield* installOperationalScope(
              tx,
              order === 'CLAIM_FIRST' ? state.governanceScope : state.scope,
            );
            const [pid] = yield* Schema.decodeUnknownEffect(pidSchema)(
              yield* state.second<{ pid: number }>`select pg_backend_pid() as pid`,
            );
            yield* Deferred.succeed(secondReady, pid.pid);
            return order === 'CLAIM_FIRST'
              ? yield* symmyJobRetentionStore(executor).purge(state.purgeInput)
              : yield* symmyJobExecutionStore(executor).claim(state.jobId, state.effectId, crypto.randomUUID());
          }),
        ),
      );
      const secondPid = yield* Deferred.await(secondReady);
      yield* Effect.gen(function* observeBlocking() {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const observed = yield* state.admin<{
            blocked: boolean;
          }>`select ${firstPid}::integer=any(pg_blocking_pids(${secondPid}::integer)) as blocked`;
          if (observed[0]?.blocked) {
            blocked = true;
            break;
          }
          yield* TestClock.adjust(Duration.millis(1));
        }
        expect(blocked).toBe(true);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseFirst, true)));
      yield* Deferred.succeed(releaseFirst, true);
      const [firstResult, secondResult] = yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)], {
        concurrency: 2,
      });
      if (order === 'CLAIM_FIRST') {
        expect(firstResult).toMatchObject({ mode: 'execute' });
        expect(secondResult).toBe('BLOCKED');
        const rows = yield* state.adminDb
          .select({ state: symmyJobEffects.state })
          .from(symmyJobEffects)
          .where(eq(symmyJobEffects.effectId, state.effectId));
        expect(rows).toEqual([{ state: 'attempting' }]);
        expect(
          yield* state.adminDb
            .select()
            .from(symmyJobRetentionTombstones)
            .where(eq(symmyJobRetentionTombstones.jobId, state.jobId)),
        ).toHaveLength(0);
      } else {
        expect(firstResult).toBe('PURGED');
        expect(secondResult).toMatchObject({ mode: 'blocked' });
        const rows = yield* state.adminDb
          .select({ effect: symmyJobEffects.effect })
          .from(symmyJobEffects)
          .where(eq(symmyJobEffects.effectId, state.effectId));
        expect(JSON.stringify(rows)).toContain('ERASED.');
        expect(JSON.stringify(rows)).not.toContain('internal-record');
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
  );
}

it.effect(
  'binds the immutable target scope and explicit verified Privacy governance scope before consulting Privacy',
  () =>
    Effect.gen(function* scopeBoundary() {
      const state = yield* fixture;
      let privacyCalls = 0;
      let approved = false;
      const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
        contentScopeRefs: [symmyJobIntentContentRef(state.jobId)],
        controllerObligationRef: null,
        dispositionDecision: 'DELETE',
        expectedEvidenceRefs: [],
        idempotencyKey: 'internal-scope-check',
        kind: 'DELETE',
        measureId: 'internal-scope-measure',
        owningCapability: 'integration.symmy',
        preconditionRefs: [],
        requestedAt: '2026-11-07T00:00:00.000Z',
        requestedResult: 'Exact operational payload',
        resourceRefs: [symmyJobResourceRef(state.jobId)],
        right: 'ERASURE',
        sourceDecisionRef: 'internal-scope-decision',
        sourceDecisionRevision: 1,
        subjectRef: 'internal-scope-subject',
        taskId: 'internal-scope-task',
        tenantId: state.scope.tenantId,
      });
      let configuredTarget: string | null = null;
      const privacy = SymmyJobPrivacy.of({
        current: () =>
          Effect.sync(() => {
            privacyCalls += 1;
            return approved
              ? {
                  authorityReceiptRef: 'internal-scope-decision',
                  sourceDecisionRevision: 1,
                  status: 'CURRENT_APPROVED' as const,
                }
              : { status: 'BLOCKED' as const };
          }),
      });
      const companyA = state.purgeInput.policy.governanceLegalEntityId;
      const companyB = Schema.decodeUnknownSync(LegalEntityIdSchema)(crypto.randomUUID());
      const run = (scope: OperationalScope) =>
        state.firstDb
          .transaction((tx) =>
            installOperationalScope(tx, scope).pipe(
              Effect.flatMap((executor) => symmyJobRetentionService(executor, scope)),
              Effect.flatMap((service) => service.purge(handoff)),
              Effect.map((result) => result.status),
            ),
          )
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                ONTOS_SYMMY_JOB_RETENTION_POLICIES: JSON.stringify([
                  { ...state.purgeInput.policy, targetLegalEntityId: configuredTarget },
                ]),
              }),
            ),
            Effect.provideService(SymmyJobPrivacy, privacy),
          );
      const wrong = yield* run({ ...state.scope, legalEntityId: companyB }).pipe(Effect.flip);
      expect(wrong).toMatchObject({ code: 'retention_scope_denied' });
      expect(privacyCalls).toBe(0);
      expect(yield* run(state.scope).pipe(Effect.flip)).toMatchObject({ code: 'retention_scope_denied' });
      expect(privacyCalls).toBe(0);
      expect(yield* run(state.governanceScope)).toBe('BLOCKED');
      expect(privacyCalls).toBe(1);
      // The provider is deliberately denied here; this tests the owner's native scoped selection, not Privacy grant acceptance.
      yield* state.adminDb
        .update(symmyImportJobs)
        .set({ legalEntityId: companyA })
        .where(eq(symmyImportJobs.jobId, state.jobId));
      expect(yield* run(state.governanceScope).pipe(Effect.flip)).toMatchObject({ code: 'retention_scope_denied' });
      expect(privacyCalls).toBe(1);
      configuredTarget = companyA;
      expect(yield* run({ ...state.scope, legalEntityId: companyB }).pipe(Effect.flip)).toMatchObject({
        code: 'retention_scope_denied',
      });
      expect(privacyCalls).toBe(1);
      expect(yield* run({ ...state.scope, legalEntityId: companyA })).toBe('BLOCKED');
      expect(privacyCalls).toBe(2);
      // TestClock is before native admittedAt: even approved eligibility cannot cancel execution before retention expires.
      approved = true;
      expect(yield* run({ ...state.scope, legalEntityId: companyA })).toBe('BLOCKED');
      expect(privacyCalls).toBe(3);
      expect(
        yield* state.adminDb
          .select()
          .from(symmyJobRetentionTombstones)
          .where(eq(symmyJobRetentionTombstones.jobId, state.jobId)),
      ).toHaveLength(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Reactivity.layer, FetchHttpClient.layer)),
    ),
);
