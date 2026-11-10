import { TrustedPrincipalContextSchema, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { SymmyEffectOutcomeSchema } from '@app/shared-contracts/symmy';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { symmyImportJobs, symmyIntegrationRelations, symmyJobEffects, symmyJobRoutes } from '../../src/db/schema.ts';
import { symmyJobExecutionStore } from '../../src/persistence/symmy-job-execution-store.ts';
import { symmyJobStoreFactory } from '../../src/persistence/symmy-job-store.ts';

const openDatabase = (connectionString: string) =>
  PgClient.makeClient({ url: Redacted.make(connectionString) }).pipe(
    Effect.flatMap((client) =>
      makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(Effect.provideService(PgClient.PgClient, client)),
    ),
  );
const makeScope = (tenantId: string, principalId: string, legalEntityId?: string): OperationalScope => {
  const identity = {
    authBindingId: crypto.randomUUID(),
    authContextRef: 'better-auth-api-key:internal-ledger-fixture',
    authMethod: 'api_key',
    principalId,
    tenantId,
  };
  return {
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(
      legalEntityId === undefined ? identity : { ...identity, legalEntityId },
    ),
    audience: 'symmy-integration',
    correlationId: 'durable-execution-ledger-fixture',
  };
};

type ExecutionStore = ReturnType<typeof symmyJobExecutionStore>;
type AdmissionStore = Effect.Success<ReturnType<typeof symmyJobStoreFactory>>;

const withScopedStores = <A, E>(
  connectionString: string,
  caller: OperationalScope,
  run: (admission: AdmissionStore, execution: ExecutionStore) => Effect.Effect<A, E>,
) =>
  openDatabase(connectionString).pipe(
    Effect.flatMap((database) =>
      database.transaction((transaction) =>
        Effect.gen(function* transactionStores() {
          const executor = yield* installOperationalScope(transaction, caller);
          const admission = yield* symmyJobStoreFactory(executor, caller);
          return yield* run(admission, symmyJobExecutionStore(executor));
        }),
      ),
    ),
    Effect.scoped,
  );

it.effect(
  'pins bounded plans and fences every original effect across leases, concurrent sessions, and route changes',
  () =>
    Effect.gen(function* verifyLedger() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const tenantId = crypto.randomUUID();
      const scope = makeScope(tenantId, crypto.randomUUID());
      const routeId = crypto.randomUUID();
      const targetId = crypto.randomUUID();
      yield* Effect.addFinalizer(() =>
        admin
          .delete(symmyJobEffects)
          .where(eq(symmyJobEffects.tenantId, tenantId))
          .pipe(
            Effect.andThen(admin.delete(symmyImportJobs).where(eq(symmyImportJobs.tenantId, tenantId))),
            Effect.andThen(admin.delete(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, tenantId))),
            Effect.orDie,
          ),
      );
      const fixtureEffect = (effectKey: string) => ({
        effectKey,
        operation: {
          entrypointKey: 'integration.symmy.fixture-effect',
          moduleId: 'integration.symmy',
          schemaVersion: '1',
        },
        originalTarget: {
          moduleId: 'integration.symmy',
          resourceId: targetId,
          resourceType: 'integration.symmy.fixture-target',
          tenantId,
        },
      });
      const source = {
        entityKind: 'product',
        issuerId: 'internal-issuer',
        sourceNamespace: 'internal-fixtures',
        sourceRecordId: 'same-record',
      };
      const fixturePlan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
        items: [
          { effects: [fixtureEffect('first'), fixtureEffect('uncertain')], itemKey: 'first-occurrence', source },
          { effects: [fixtureEffect('pending')], itemKey: 'second-occurrence', source },
        ],
      });
      yield* admin.insert(symmyJobRoutes).values({
        active: true,
        fixtureIds: ['internal-ledger'],
        fixturePlan,
        mappingVersion: 'mapping-original',
        principalId: scope.principalId,
        routeId,
        routeKey: 'productsBatch',
        routeRevision: 'route-original',
        tenantId,
      });
      const scoped = <A, E>(
        run: (admission: AdmissionStore, execution: ExecutionStore) => Effect.Effect<A, E>,
        caller = scope,
      ) => withScopedStores(connections.runtime.connectionString, caller, run);
      const request = {
        fixtureId: 'internal-ledger',
        idempotencyKey: 'internal-ledger-key',
        routeKey: 'productsBatch' as const,
      };
      const admitted = yield* scoped((admission) => admission.admit(request));
      expect(admitted).toMatchObject({ executionReady: true, inserted: true });
      const sleScope = makeScope(tenantId, scope.principalId, crypto.randomUUID());
      yield* admin.insert(symmyJobRoutes).values({
        active: true,
        fixtureIds: ['internal-ledger'],
        fixturePlan,
        legalEntityId: sleScope.legalEntityId,
        mappingVersion: 'mapping-original',
        principalId: scope.principalId,
        routeKey: 'productsBatch',
        routeRevision: 'route-original',
        tenantId,
      });
      const scopedAdmission = yield* scoped(
        (admission) => admission.admit({ ...request, idempotencyKey: 'supported-sle' }),
        sleScope,
      );
      expect(scopedAdmission).toMatchObject({ executionReady: true, inserted: true });
      const scopedJob = yield* scoped((_admission, execution) => execution.load(scopedAdmission.jobId), sleScope);
      expect(Option.getOrUndefined(Option.getOrUndefined(scopedJob)?.legalEntityId ?? Option.none())).toBe(
        sleScope.legalEntityId,
      );
      const tenantPoll = yield* scoped((admission) => admission.poll(scopedAdmission.jobId));
      expect(Option.getOrUndefined(tenantPoll)?.jobId).toBe(scopedAdmission.jobId);
      expect(JSON.stringify(tenantPoll)).not.toContain(sleScope.legalEntityId);
      expect(JSON.stringify(tenantPoll)).not.toContain(targetId);
      expect(JSON.stringify(tenantPoll)).not.toContain('same-record');
      expect(
        yield* scoped((admission) => admission.poll(scopedAdmission.jobId), makeScope(tenantId, crypto.randomUUID())),
      ).toEqual(Option.none());
      expect(
        yield* scoped(
          (admission) => admission.poll(scopedAdmission.jobId),
          makeScope(crypto.randomUUID(), scope.principalId),
        ),
      ).toEqual(Option.none());
      expect(
        yield* scoped(
          (admission) => admission.poll(scopedAdmission.jobId),
          makeScope(tenantId, scope.principalId, crypto.randomUUID()),
        ),
      ).toEqual(Option.none());
      expect(yield* admin.select().from(symmyImportJobs).where(eq(symmyImportJobs.tenantId, tenantId))).toHaveLength(2);
      const maybeJob = yield* scoped((_admission, execution) => execution.load(admitted.jobId));
      if (Option.isNone(maybeJob)) {
        return yield* Effect.die('admitted execution must exist');
      }
      const job = maybeJob.value;
      const [firstItem, secondItem] = job.plan.items;
      const [first, uncertain] = firstItem.effects;
      const pending = secondItem?.effects[0];
      if (uncertain === undefined || pending === undefined) {
        return yield* Effect.die('bounded sibling fixture missing');
      }
      expect(first.ref.effectId).not.toBe(uncertain.ref.effectId);
      expect(first.ref.occurrence).toEqual(uncertain.ref.occurrence);
      expect(first.ref.occurrence.occurrenceId).not.toBe(pending.ref.occurrence.occurrenceId);
      expect(first.ref.occurrence.record).toEqual(pending.ref.occurrence.record);
      expect(first.itemId).not.toBe(pending.itemId);
      expect(first.ref.originalTarget?.resourceId).toBe(targetId);

      const firstToken = crypto.randomUUID();
      const firstClaim = yield* scoped((_admission, execution) =>
        execution.claim(job.jobId, first.ref.effectId, firstToken),
      );
      expect(firstClaim.mode).toBe('execute');
      const accepted = Schema.decodeUnknownSync(SymmyEffectOutcomeSchema)({
        effectId: first.ref.effectId,
        owner: 'integration.symmy',
        status: 'accepted_change',
      });
      expect(
        yield* scoped((_admission, execution) =>
          execution.settle(job.jobId, first.ref.effectId, firstToken, firstClaim.version, accepted),
        ),
      ).toBe(true);
      expect(
        yield* scoped((_admission, execution) =>
          execution.settle(job.jobId, first.ref.effectId, firstToken, firstClaim.version, accepted),
        ),
      ).toBe(false);

      const tokens = [crypto.randomUUID(), crypto.randomUUID()];
      const claims = yield* Effect.all(
        tokens.map((token) =>
          scoped((_admission, execution) => execution.claim(job.jobId, uncertain.ref.effectId, token)),
        ),
        { concurrency: 2 },
      );
      expect(claims.filter(({ mode }) => mode === 'execute')).toHaveLength(1);
      expect(claims.filter(({ mode }) => mode === 'busy')).toHaveLength(1);
      const winner = claims.findIndex(({ mode }) => mode === 'execute');
      const winnerClaim = claims[winner];
      const winnerToken = tokens[winner];
      if (winnerClaim === undefined || winnerToken === undefined) {
        return yield* Effect.die('one claim must win');
      }
      const attempt = {
        authContextRef: 'fixture-source-owner-request',
        executorPrincipalId: crypto.randomUUID(),
        requestHash: 'a'.repeat(64),
      };
      const invalidPin = yield* scoped((_admission, execution) =>
        execution.recordOwnerRequest(job.jobId, uncertain.ref.effectId, winnerToken, winnerClaim.version, {
          ...attempt,
          requestHash: 'invalid-hash',
        }),
      ).pipe(Effect.flip);
      expect(invalidPin).toMatchObject({ code: 'unavailable' });
      const afterPinRollback = yield* scoped((_admission, execution) => execution.load(job.jobId));
      expect(
        Option.getOrUndefined(afterPinRollback)?.effects.find(
          ({ effect }) => effect.ref.effectId === uncertain.ref.effectId,
        ),
      ).toMatchObject({
        ownerAuthContextRef: Option.none(),
        ownerExecutorPrincipalId: Option.none(),
        ownerRequestHash: Option.none(),
      });
      // An older worker could have committed only the executor before losing its lease.
      expect(
        yield* scoped((_admission, execution) =>
          execution.recordExecutor(
            job.jobId,
            uncertain.ref.effectId,
            winnerToken,
            winnerClaim.version,
            attempt.executorPrincipalId,
          ),
        ),
      ).toBe(true);
      expect(
        yield* scoped((_admission, execution) =>
          execution.markIndeterminate(
            job.jobId,
            uncertain.ref.effectId,
            winnerToken,
            winnerClaim.version,
            'unavailable',
          ),
        ),
      ).toBe(true);
      expect(
        yield* scoped((_admission, execution) =>
          execution.markIndeterminate(job.jobId, uncertain.ref.effectId, winnerToken, winnerClaim.version),
        ),
      ).toBe(false);
      const unavailablePoll = Option.getOrUndefined(yield* scoped((admission) => admission.poll(job.jobId)));
      expect(unavailablePoll?.items.flatMap(({ effects }) => effects)).toContainEqual({
        effectId: uncertain.ref.effectId,
        owner: uncertain.ref.operation.moduleId,
        status: 'unavailable',
      });
      const recoveryToken = crypto.randomUUID();
      const recovery = yield* scoped((_admission, execution) =>
        execution.claim(job.jobId, uncertain.ref.effectId, recoveryToken),
      );
      expect(recovery.mode).toBe('recover');
      yield* scoped((_admission, execution) =>
        execution.recordOwnerRequest(job.jobId, uncertain.ref.effectId, recoveryToken, recovery.version, attempt),
      );
      const conflictingPin = yield* scoped((_admission, execution) =>
        execution.recordOwnerRequest(job.jobId, uncertain.ref.effectId, recoveryToken, recovery.version, {
          ...attempt,
          requestHash: 'b'.repeat(64),
        }),
      ).pipe(Effect.flip);
      expect(conflictingPin).toMatchObject({ code: 'unavailable' });
      const pinnedJob = yield* scoped((_admission, execution) => execution.load(job.jobId));
      expect(
        Option.getOrUndefined(pinnedJob)?.effects.find(({ effect }) => effect.ref.effectId === uncertain.ref.effectId),
      ).toMatchObject({
        ownerAuthContextRef: Option.some(attempt.authContextRef),
        ownerExecutorPrincipalId: Option.some(attempt.executorPrincipalId),
        ownerRequestHash: Option.some(attempt.requestHash),
      });
      yield* admin
        .update(symmyJobEffects)
        .set({ leaseUntil: new Date(0) })
        .where(eq(symmyJobEffects.effectId, uncertain.ref.effectId));
      yield* admin
        .update(symmyJobRoutes)
        .set({ active: false, fixturePlan: null, mappingVersion: 'mapping-new', routeRevision: 'route-new' })
        .where(eq(symmyJobRoutes.routeId, routeId));
      const expired = yield* scoped((_admission, execution) => execution.load(job.jobId));
      expect(
        Option.getOrUndefined(expired)?.effects.find(({ effect }) => effect.ref.effectId === uncertain.ref.effectId)
          ?.state,
      ).toBe('indeterminate');
      const originalToken = crypto.randomUUID();
      const original = yield* scoped((_admission, execution) =>
        execution.claim(job.jobId, uncertain.ref.effectId, originalToken),
      );
      expect(original.mode).toBe('recover');
      expect(Option.getOrUndefined(original.effect)).toEqual(uncertain);
      expect(original.version).toBeGreaterThan(recovery.version);
      expect(
        yield* scoped((_admission, execution) =>
          execution.canExecute(job.jobId, uncertain.ref.effectId, originalToken, original.version),
        ),
      ).toBe(false);
      expect(
        (yield* scoped((_admission, execution) =>
          execution.claim(job.jobId, pending.ref.effectId, crypto.randomUUID()),
        )).mode,
      ).toBe('blocked');
      const recovered = Schema.decodeUnknownSync(SymmyEffectOutcomeSchema)({
        effectId: uncertain.ref.effectId,
        owner: 'integration.symmy',
        status: 'accepted_change',
      });
      expect(
        yield* scoped((_admission, execution) =>
          execution.settle(job.jobId, uncertain.ref.effectId, recoveryToken, recovery.version, recovered),
        ),
      ).toBe(false);
      expect(
        yield* scoped((_admission, execution) =>
          execution.settle(job.jobId, uncertain.ref.effectId, originalToken, original.version, recovered),
        ),
      ).toBe(true);
      expect(
        (yield* scoped((_admission, execution) => execution.claim(job.jobId, first.ref.effectId, crypto.randomUUID())))
          .mode,
      ).toBe('settled');
      const poll = yield* scoped((admission) => admission.poll(job.jobId));
      expect(Option.getOrUndefined(poll)?.phase).toBe('blocked');
      expect(JSON.stringify(poll)).not.toContain('same-record');
      expect(JSON.stringify(poll)).not.toContain(targetId);
      const foreignScope = makeScope(crypto.randomUUID(), scope.principalId);
      expect(yield* scoped((_admission, execution) => execution.load(job.jobId), foreignScope)).toEqual(Option.none());
      expect(
        (yield* scoped(
          (_admission, execution) => execution.claim(job.jobId, pending.ref.effectId, crypto.randomUUID()),
          foreignScope,
        )).mode,
      ).toBe('blocked');

      // Legacy admissions cannot acquire today's plan, even after the operator enrolls one later.
      yield* admin.update(symmyJobRoutes).set({ active: true }).where(eq(symmyJobRoutes.routeId, routeId));
      const legacy = yield* scoped((admission) => admission.admit({ ...request, idempotencyKey: 'legacy-no-plan' }));
      expect(legacy.executionReady).toBe(false);
      yield* admin.update(symmyJobRoutes).set({ fixturePlan }).where(eq(symmyJobRoutes.routeId, routeId));
      const unavailable = yield* scoped((_admission, execution) => execution.load(legacy.jobId)).pipe(Effect.flip);
      expect(unavailable).toMatchObject({ code: 'unavailable' });
      expect(yield* scoped((admission) => admission.poll(legacy.jobId))).toEqual(
        Option.some({
          items: [],
          jobId: legacy.jobId,
          phase: 'blocked',
        }),
      );
      expect(
        (yield* scoped((_admission, execution) =>
          execution.claim(job.jobId, pending.ref.effectId, crypto.randomUUID()),
        )).mode,
      ).toBe('blocked');
      yield* admin
        .update(symmyJobRoutes)
        .set({ mappingVersion: 'mapping-original', routeRevision: 'route-original' })
        .where(eq(symmyJobRoutes.routeId, routeId));
      const pendingToken = crypto.randomUUID();
      const pendingClaim = yield* scoped((_admission, execution) =>
        execution.claim(job.jobId, pending.ref.effectId, pendingToken),
      );
      expect(pendingClaim.mode).toBe('execute');
      expect(
        yield* scoped((_admission, execution) =>
          execution.canExecute(job.jobId, pending.ref.effectId, pendingToken, pendingClaim.version),
        ),
      ).toBe(true);
      expect(
        yield* scoped((_admission, execution) =>
          execution.markBlocked(job.jobId, pending.ref.effectId, pendingToken, pendingClaim.version),
        ),
      ).toBe(true);
      expect(
        yield* scoped((_admission, execution) =>
          execution.markBlocked(job.jobId, pending.ref.effectId, pendingToken, pendingClaim.version),
        ),
      ).toBe(false);
      expect(Option.getOrUndefined(yield* scoped((admission) => admission.poll(job.jobId)))?.phase).toBe('blocked');
      const resumedToken = crypto.randomUUID();
      const resumed = yield* scoped((_admission, execution) =>
        execution.claim(job.jobId, pending.ref.effectId, resumedToken),
      );
      expect(resumed.mode).toBe('execute');
      expect(Option.getOrUndefined(resumed.effect)).toEqual(pending);
      const pendingAccepted = Schema.decodeUnknownSync(SymmyEffectOutcomeSchema)({
        effectId: pending.ref.effectId,
        owner: 'integration.symmy',
        status: 'accepted_change',
      });
      expect(
        yield* scoped((_admission, execution) =>
          execution.settle(job.jobId, pending.ref.effectId, resumedToken, resumed.version, pendingAccepted),
        ),
      ).toBe(true);
      expect(Option.getOrUndefined(yield* scoped((admission) => admission.poll(job.jobId)))?.phase).toBe(
        'completed_all',
      );
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);
