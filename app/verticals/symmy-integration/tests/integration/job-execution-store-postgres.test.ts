import {
  TrustedPrincipalContextSchema,
  defineAction,
  defineTenantModuleEntrypoint,
  findPostgresFailure,
  loadDatabaseConnectionPair,
  runAction,
} from '@app/core-runtime';
import type { ActionHandlerContext, OperationalScope } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { installOperationalScope, makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { SymmyEffectOutcomeSchema } from '@app/shared-contracts/symmy';
import { ProvisionSourceStockItemPayloadSchema } from '@app/inventory/api/provision-source-stock-item-action';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { DateTime, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';

import type { SymmyPinnedEffect } from '../../shared/domain/symmy-job-execution.ts';
import {
  SymmyFixtureExecutionPlanSchema,
  SymmyPinnedEffectSchema,
  SymmyPinnedJobPlanSchema,
} from '../../shared/domain/symmy-job-execution.ts';
import { SymmyStockPositionFactsSchema, SymmyStockRowsSchema } from '../../shared/domain/symmy-stock-batch.ts';
import { AdmitSymmySyncPayloadSchema, AdmitSymmySyncResultSchema } from '../../shared/actions/admit-symmy-sync.ts';
import {
  symmyImportJobs,
  symmyIntegrationRelations,
  symmyJobEffects,
  symmyJobRoutes,
  symmySyncAdmissionAttempts,
  symmySyncAdmissions,
} from '../../src/db/schema.ts';
import { symmyJobExecutionStore } from '../../src/persistence/symmy-job-execution-store.ts';
import { SymmyJobStoreError, symmyJobStoreFactory } from '../../src/persistence/symmy-job-store.ts';
import { makeTestOperationOwner } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { buildSymmyStockPlan, stockOperation } from '../../src/persistence/symmy-stock-plan.ts';

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
const inventoryRefFor = (tenantId: string) => (kind: string) => ({
  moduleId: 'commerce.inventory',
  resourceId: crypto.randomUUID(),
  resourceType: `commerce.inventory.${kind}`,
  tenantId,
});
const sha256Digest = (value: string) =>
  Effect.promise(async () =>
    Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex'),
  );

/** The pinned effect with another command and, when given, the target it was resolved onto. */
const pinnedWith = (effect: SymmyPinnedEffect, intent: Schema.Json, originalTarget: Schema.Json | null) => {
  const encoded = Schema.encodeSync(SymmyPinnedEffectSchema)(effect);
  const ref = originalTarget === null ? encoded.ref : { ...encoded.ref, originalTarget };
  return Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({ ...encoded, intent, ref });
};

type ExecutionStore = ReturnType<typeof symmyJobExecutionStore>;
type AdmissionStore = Effect.Success<ReturnType<typeof symmyJobStoreFactory>>;

const retiredReceiptProbeKey = 'integration.symmy.test-retired-stock-receipt';
const retiredReceiptProbe = defineAction(
  {
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${retiredReceiptProbeKey}.access.v1` },
    actionKey: retiredReceiptProbeKey,
    auditProfile: 'standard',
    domainErrorSchema: SymmyJobStoreError,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: retiredReceiptProbeKey,
      moduleKey: 'integration.symmy',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'integration.symmy',
    payloadSchema: AdmitSymmySyncPayloadSchema,
    policies: [],
    resultSchema: AdmitSymmySyncResultSchema,
    schemaVersion: '1',
  },
  (
    payload: typeof AdmitSymmySyncPayloadSchema.Type,
    context: ActionHandlerContext<Record<never, never>, AdmissionStore>,
  ) => context.services.admitSync(payload, context.actionInvocationId),
  symmyJobStoreFactory,
);

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
      const pendingInvalid = Schema.decodeUnknownSync(SymmyEffectOutcomeSchema)({
        effectId: pending.ref.effectId,
        owner: 'integration.symmy',
        status: 'invalid',
      });
      expect(
        yield* scoped((_admission, execution) =>
          execution.settle(job.jobId, pending.ref.effectId, resumedToken, resumed.version, pendingInvalid),
        ),
      ).toBe(true);
      const terminalPoll = Option.getOrUndefined(yield* scoped((admission) => admission.poll(job.jobId)));
      expect(terminalPoll?.phase).toBe('completed_partial');
      expect(terminalPoll?.items.flatMap(({ effects }) => effects)).toContainEqual(pendingInvalid);
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);

it.effect('polls items[n] as request item n when a customer plans a contact item of its own', () =>
  Effect.gen(function* verifyRequestOrder() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const admin = yield* openDatabase(connections.admin.connectionString);
    const tenantId = crypto.randomUUID();
    const scope = makeScope(tenantId, crypto.randomUUID());
    const routeId = crypto.randomUUID();
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
    const planItem = (itemKey: string, effectKey: string) => ({
      effects: [
        {
          effectKey,
          operation: {
            entrypointKey: 'integration.symmy.fixture-effect',
            moduleId: 'integration.symmy',
            schemaVersion: '1',
          },
          originalTarget: {
            moduleId: 'integration.symmy',
            resourceId: crypto.randomUUID(),
            resourceType: 'integration.symmy.fixture-target',
            tenantId,
          },
        },
      ],
      itemKey,
      source: {
        entityKind: 'customer',
        issuerId: 'internal-issuer',
        sourceNamespace: 'internal-fixtures',
        sourceRecordId: itemKey,
      },
    });
    // Two customers, the first with a contact: the plan has three items, the request has two.
    const fixturePlan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
      items: [
        planItem('customer-0', 'party-create'),
        planItem('contact-0-0', 'contact-add'),
        planItem('customer-1', 'party-create'),
      ],
    });
    yield* admin.insert(symmyJobRoutes).values({
      active: true,
      fixtureIds: ['internal-order'],
      fixturePlan,
      mappingVersion: 'mapping-original',
      principalId: scope.principalId,
      routeId,
      routeKey: 'productsBatch',
      routeRevision: 'route-original',
      tenantId,
    });
    const scoped = <A, E>(run: (admission: AdmissionStore, execution: ExecutionStore) => Effect.Effect<A, E>) =>
      withScopedStores(connections.runtime.connectionString, scope, run);
    const admitted = yield* scoped((admission) =>
      admission.admit({ fixtureId: 'internal-order', idempotencyKey: 'internal-order-key', routeKey: 'productsBatch' }),
    );
    const job = Option.getOrThrow(yield* scoped((_admission, execution) => execution.load(admitted.jobId)));
    const [customer, contact, second] = job.plan.items;
    if (customer === undefined || contact === undefined || second === undefined) {
      return yield* Effect.die('the three plan items must exist');
    }
    const waiting = Option.getOrThrow(yield* scoped((admission) => admission.poll(admitted.jobId)));
    expect(waiting.items.map(({ itemId }) => itemId)).toEqual([customer.itemId, second.itemId]);
    expect(waiting.items.map(({ effects }) => effects.map(({ status }) => status))).toEqual([
      ['waiting', 'waiting'],
      ['waiting'],
    ]);
    const settle = (effectId: string, status: 'accepted_change' | 'denied') =>
      Effect.gen(function* settleEffect() {
        const token = crypto.randomUUID();
        const claim = yield* scoped((_admission, execution) => execution.claim(job.jobId, effectId, token));
        const outcome = Schema.decodeUnknownSync(SymmyEffectOutcomeSchema)(
          status === 'denied'
            ? { owner: 'integration.symmy', status }
            : { effectId, owner: 'integration.symmy', status },
        );
        expect(
          yield* scoped((_admission, execution) =>
            execution.settle(job.jobId, effectId, token, claim.version, outcome),
          ),
        ).toBe(true);
      });
    const [customerEffect] = customer.effects;
    const [contactEffect] = contact.effects;
    const [secondEffect] = second.effects;
    if (customerEffect === undefined || contactEffect === undefined || secondEffect === undefined) {
      return yield* Effect.die('every plan item has an effect');
    }
    yield* settle(customerEffect.ref.effectId, 'accepted_change');
    yield* settle(contactEffect.ref.effectId, 'denied');
    yield* settle(secondEffect.ref.effectId, 'accepted_change');
    const settled = Option.getOrThrow(yield* scoped((admission) => admission.poll(admitted.jobId)));
    expect(settled.phase).toBe('completed_partial');
    expect(settled.items.map(({ itemId }) => itemId)).toEqual([customer.itemId, second.itemId]);
    expect(settled.items.map(({ effects }) => effects.map(({ status }) => status))).toEqual([
      ['accepted_change', 'denied'],
      ['accepted_change'],
    ]);
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);

it.effect('records the company ICO resolved onto the profile of its own item, and refuses any other resolution', () =>
  Effect.gen(function* verifyIcoResolution() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const admin = yield* openDatabase(connections.admin.connectionString);
    const tenantId = crypto.randomUUID();
    const scope = makeScope(tenantId, crypto.randomUUID());
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
    const commerce = 'commerce.customer-context';
    const profileRef = {
      moduleId: commerce,
      resourceId: crypto.randomUUID(),
      resourceType: `${commerce}.counterparty-purchasing-profile`,
      tenantId,
    };
    const sourceReference = {
      occurrenceId: crypto.randomUUID(),
      recordId: 'customer-0',
      source: { issuer: 'internal-issuer', namespace: 'internal-fixtures', recordType: 'customer', routeRef: 'route' },
    };
    const dependent = {
      _tag: 'OrganizationCustomerProfileIcoFromProfileEffect',
      fromProfileEffect: { effectKey: 'counterparty-profile', itemKey: 'customer-0' },
      payload: {
        countryCode: 'CZ',
        effectiveAt: '2026-11-16T10:00:00.000Z',
        expectedRevision: 0,
        identifier: { identifierType: 'ICO', value: '27074358' },
        operation: 'SET',
        originalInput: '27074358',
      },
      sourceReference,
    };
    const fixturePlan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
      items: [
        {
          effects: [
            {
              effectKey: 'counterparty-profile',
              operation: {
                entrypointKey: `${commerce}.create-counterparty-purchasing-profile`,
                moduleId: commerce,
                schemaVersion: '1',
              },
            },
            {
              dependsOn: ['counterparty-profile'],
              effectKey: 'ico-set',
              operation: {
                entrypointKey: `${commerce}.change-organization-customer-profile-ico`,
                moduleId: commerce,
                schemaVersion: '1',
              },
            },
          ],
          itemKey: 'customer-0',
          source: {
            entityKind: 'customer',
            issuerId: 'internal-issuer',
            sourceNamespace: 'internal-fixtures',
            sourceRecordId: 'customer-0',
          },
        },
      ],
    });
    yield* admin.insert(symmyJobRoutes).values({
      active: true,
      fixtureIds: ['internal-ico'],
      fixturePlan,
      mappingVersion: 'mapping-original',
      principalId: scope.principalId,
      routeId: crypto.randomUUID(),
      routeKey: 'productsBatch',
      routeRevision: 'route-original',
      tenantId,
    });
    const scoped = <A, E>(run: (admission: AdmissionStore, execution: ExecutionStore) => Effect.Effect<A, E>) =>
      withScopedStores(connections.runtime.connectionString, scope, run);
    const admitted = yield* scoped((admission) =>
      admission.admit({ fixtureId: 'internal-ico', idempotencyKey: 'internal-ico-key', routeKey: 'productsBatch' }),
    );
    const job = Option.getOrThrow(yield* scoped((_admission, execution) => execution.load(admitted.jobId)));
    const [profile, ico] = job.plan.items[0]?.effects ?? [];
    if (profile === undefined || ico === undefined) {
      return yield* Effect.die('the customer item must plan the profile and its ICO');
    }
    const profileToken = crypto.randomUUID();
    const profileClaim = yield* scoped((_admission, execution) =>
      execution.claim(job.jobId, profile.ref.effectId, profileToken),
    );
    expect(
      yield* scoped((_admission, execution) =>
        execution.settle(
          job.jobId,
          profile.ref.effectId,
          profileToken,
          profileClaim.version,
          Schema.decodeUnknownSync(SymmyEffectOutcomeSchema)({
            effectId: profile.ref.effectId,
            owner: commerce,
            status: 'accepted_change',
          }),
        ),
      ),
    ).toBe(true);
    const token = crypto.randomUUID();
    const claim = yield* scoped((_admission, execution) => execution.claim(job.jobId, ico.ref.effectId, token));
    // Fixture admission pins no intent, so the dependent command is grafted onto the claimed effect, as a real admission
    // of the customer plan stores it (a claim needs the stored effect to equal the pinned one, so it follows the claim).
    yield* admin
      .update(symmyJobEffects)
      .set({ effect: pinnedWith(ico, dependent, null) })
      .where(eq(symmyJobEffects.effectId, ico.ref.effectId));
    const resolution = {
      intent: {
        _tag: 'OrganizationCustomerProfileIco',
        payload: { ...dependent.payload, effectId: ico.ref.effectId, profileRef },
        sourceReference,
      },
      originalTarget: profileRef,
    };
    const resolved = pinnedWith(ico, resolution.intent, resolution.originalTarget);
    const resolvedJson = Schema.encodeSync(SymmyPinnedEffectSchema)(resolved);
    for (const malformedIntent of [undefined, {}, { _tag: null }, null, 'not-an-object', { _tag: 'UnknownIntent' }]) {
      const bad = { ...resolvedJson, intent: malformedIntent };
      const failure = yield* admin
        .transaction((transaction) =>
          Effect.gen(function* malformedResolution() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            return yield* transaction.execute(
              sql`select * from symmy_integration.record_symmy_resolved_effect(
                ${tenantId}::uuid, ${job.jobId}::uuid, ${ico.ref.effectId}::uuid,
                ${token}::uuid, ${claim.version}::integer, ${JSON.stringify(bad)}::jsonb)`,
              'objects',
            );
          }),
        )
        .pipe(Effect.flip);
      expect(Option.getOrThrow(findPostgresFailure(failure))).toMatchObject({ code: '22023' });
    }
    for (const malformedIntent of [{}, { _tag: null }, null, 'not-an-object', { _tag: 'UnknownIntent' }]) {
      const failure = yield* admin
        .transaction((transaction) =>
          Effect.gen(function* malformedOriginal() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            yield* transaction.execute(
              sql`update symmy_integration.job_effects
                set effect = jsonb_set(effect, '{intent}', ${JSON.stringify(malformedIntent)}::jsonb)
                where tenant_id = ${tenantId}::uuid and effect_id = ${ico.ref.effectId}::uuid`,
              'objects',
            );
            return yield* transaction.execute(
              sql`select * from symmy_integration.record_symmy_resolved_effect(
                ${tenantId}::uuid, ${job.jobId}::uuid, ${ico.ref.effectId}::uuid,
                ${token}::uuid, ${claim.version}::integer, ${JSON.stringify(resolvedJson)}::jsonb)`,
              'objects',
            );
          }),
        )
        .pipe(Effect.flip);
      expect(Option.getOrThrow(findPostgresFailure(failure))).toMatchObject({ code: '22023' });
    }
    const record = (effect: SymmyPinnedEffect) =>
      scoped((_admission, execution) =>
        execution.recordResolvedEffect(job.jobId, ico.ref.effectId, token, claim.version, effect),
      ).pipe(Effect.result);
    // The unresolved command again is no resolution of the ICO. A target of another Tenant or module cannot even be
    // pinned: the effect schema refuses it before the routine is asked.
    expect(Result.isFailure(yield* record(pinnedWith(ico, dependent, profileRef)))).toBe(true);
    expect(() => pinnedWith(ico, resolution.intent, { ...profileRef, tenantId: crypto.randomUUID() })).toThrow();
    expect(() => pinnedWith(ico, resolution.intent, { ...profileRef, moduleId: 'party.registry' })).toThrow();
    const [none] = yield* admin
      .select({ resolved: symmyJobEffects.resolvedEffect })
      .from(symmyJobEffects)
      .where(eq(symmyJobEffects.effectId, ico.ref.effectId));
    expect(none?.resolved).toBeNull();
    expect(Result.getOrNull(yield* record(resolved))).toBe(true);
    const [stored] = yield* admin
      .select({ resolved: symmyJobEffects.resolvedEffect })
      .from(symmyJobEffects)
      .where(eq(symmyJobEffects.effectId, ico.ref.effectId));
    expect(stored?.resolved).toMatchObject({
      intent: { _tag: 'OrganizationCustomerProfileIco' },
      ref: { originalTarget: { resourceId: profileRef.resourceId } },
    });
    // The same resolution is recorded once: asking again for it answers the same, another one is not applied.
    expect(Result.getOrNull(yield* record(resolved))).toBe(true);
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);

it.effect(
  'pins a product-dependent Inventory provisioning command once and resumes its exact target after interruption',
  () =>
    Effect.gen(function* provisionResolution() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const tenantId = crypto.randomUUID();
      const scope = makeScope(tenantId, crypto.randomUUID());
      const inventoryRef = inventoryRefFor(tenantId);
      const policyRef = inventoryRef('source-provisioning-policy');
      const source = {
        customerConfigurationId: 'provisioning-fixture',
        externalScope: 'source-scope',
        issuer: { backendId: 'fixture-backend', backendKind: 'external_business_system' },
        locations: [
          { locationKey: 'warehouse', stockLocationRef: inventoryRef('stock-location') },
          { locationKey: 'outlet', stockLocationRef: inventoryRef('stock-location') },
        ],
        namespace: 'fixture-namespace',
        policyRef,
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: crypto.randomUUID(),
          resourceType: 'commerce.catalog.product-unit',
          tenantId,
        },
      };
      const productRef = {
        moduleId: 'commerce.catalog',
        resourceId: crypto.randomUUID(),
        resourceType: 'commerce.catalog.product',
        tenantId,
      };
      const variantRef = {
        moduleId: 'commerce.catalog',
        resourceId: crypto.randomUUID(),
        resourceType: 'commerce.catalog.variant',
        tenantId,
      };
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
      const fixturePlan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
        items: [
          {
            effects: [
              {
                effectKey: 'product-create',
                operation: {
                  entrypointKey: 'commerce.catalog.create-product',
                  moduleId: 'commerce.catalog',
                  schemaVersion: '2',
                },
              },
              {
                dependsOn: ['product-create'],
                effectKey: 'inventory-provision',
                operation: {
                  entrypointKey: 'commerce.inventory.provision-source-stock-item',
                  moduleId: 'commerce.inventory',
                  schemaVersion: '1',
                },
              },
            ],
            itemKey: 'product-0',
            source: { entityKind: 'PRODUCT', issuerId: 'fixture', sourceNamespace: 'fixture', sourceRecordId: 'sku' },
          },
        ],
      });
      yield* admin.insert(symmyJobRoutes).values({
        active: true,
        fixtureIds: ['provisioning-resolution'],
        fixturePlan,
        mappingVersion: 'mapping-1',
        principalId: scope.principalId,
        routeId: crypto.randomUUID(),
        routeKey: 'productsBatch',
        routeRevision: 'r1',
        tenantId,
      });
      const scoped = <A, E>(run: (admission: AdmissionStore, execution: ExecutionStore) => Effect.Effect<A, E>) =>
        withScopedStores(connections.runtime.connectionString, scope, run);
      const admitted = yield* scoped((admission) =>
        admission.admit({
          fixtureId: 'provisioning-resolution',
          idempotencyKey: 'provisioning-resolution',
          routeKey: 'productsBatch',
        }),
      );
      const job = Option.getOrThrow(yield* scoped((_admission, execution) => execution.load(admitted.jobId)));
      const [parent, provision] = job.plan.items[0]?.effects ?? [];
      assert.isDefined(parent);
      assert.isDefined(provision);
      const parentToken = crypto.randomUUID();
      const parentClaim = yield* scoped((_admission, execution) =>
        execution.claim(job.jobId, parent.ref.effectId, parentToken),
      );
      yield* scoped((_admission, execution) =>
        execution.settle(
          job.jobId,
          parent.ref.effectId,
          parentToken,
          parentClaim.version,
          Schema.decodeUnknownSync(SymmyEffectOutcomeSchema)({
            effectId: parent.ref.effectId,
            owner: 'commerce.catalog',
            status: 'accepted_change',
          }),
        ),
      );
      const token = crypto.randomUUID();
      const claim = yield* scoped((_admission, execution) => execution.claim(job.jobId, provision.ref.effectId, token));
      const dependent = {
        _tag: 'CatalogProductDependentEffect',
        parent: { effectKey: 'product-create', itemKey: 'product-0' },
        request: { _tag: 'ProvisionSourceStockItem', itemKey: 'unseen-SKU', source },
      };
      yield* admin
        .update(symmyJobEffects)
        .set({ effect: pinnedWith(provision, dependent, null) })
        .where(eq(symmyJobEffects.effectId, provision.ref.effectId));
      const native = {
        _tag: 'InventoryProvision',
        payload: Schema.encodeSync(ProvisionSourceStockItemPayloadSchema)(
          Schema.decodeUnknownSync(ProvisionSourceStockItemPayloadSchema)({
            catalogSelection: { productRef, variantRef },
            exactSelectionMeaning: { id: `catalog-variant:${variantRef.resourceId}`, kind: 'PRODUCT_VARIANT' },
            expectedPolicy: {
              customerConfigurationId: source.customerConfigurationId,
              externalScope: source.externalScope,
              issuer: source.issuer,
              locations: source.locations,
              namespace: source.namespace,
              unitRef: source.unitRef,
            },
            itemKey: 'unseen-SKU',
            policyRef,
          }),
        ),
        source,
      };
      expect(source.locations.map(({ locationKey }) => locationKey)).toEqual(['warehouse', 'outlet']);
      expect(native.payload.expectedPolicy.locations.map(({ locationKey }) => locationKey)).toEqual([
        'outlet',
        'warehouse',
      ]);
      const resolved = pinnedWith(provision, native, policyRef);
      const record = (effect: SymmyPinnedEffect) =>
        scoped((_admission, execution) =>
          execution.recordResolvedEffect(job.jobId, provision.ref.effectId, token, claim.version, effect),
        );
      for (const locations of [
        native.payload.expectedPolicy.locations.slice(1),
        native.payload.expectedPolicy.locations.flatMap((location, index) =>
          index === 0 ? [location, location] : [location],
        ),
        native.payload.expectedPolicy.locations.map((location, index) =>
          index === 0 ? { ...location, stockLocationRef: inventoryRef('stock-location') } : location,
        ),
      ]) {
        const failure = yield* record(
          pinnedWith(
            provision,
            {
              ...native,
              payload: { ...native.payload, expectedPolicy: { ...native.payload.expectedPolicy, locations } },
            },
            policyRef,
          ),
        ).pipe(Effect.flip);
        expect(Option.getOrThrow(findPostgresFailure(failure))).toMatchObject({ code: '22023' });
      }
      expect(yield* record(resolved)).toBe(true);
      // The original resolution survives a response loss; replay cannot choose another policy or native target.
      expect(yield* record(resolved)).toBe(true);
      const differentPolicy = inventoryRef('source-provisioning-policy');
      const policyTampering = yield* record(
        pinnedWith(
          provision,
          { ...native, payload: { ...native.payload, policyRef: differentPolicy } },
          differentPolicy,
        ),
      ).pipe(Effect.flip);
      expect(Option.getOrThrow(findPostgresFailure(policyTampering))).toMatchObject({ code: '22023' });
      const refreshed = Option.getOrThrow(yield* scoped((_admission, execution) => execution.load(job.jobId)));
      const saved = refreshed.effects.find(({ effect }) => effect.ref.effectId === provision.ref.effectId);
      expect(Option.getOrUndefined(saved?.resolvedEffect ?? Option.none())).toMatchObject({
        intent: native,
        ref: { originalTarget: policyRef },
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);

it.effect(
  'prioritizes retained stock keys on configured routes while preserving conflict, retention and caller scope',
  () =>
    Effect.gen(function* stockReplayContext() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const tenantId = crypto.randomUUID();
      const scope = makeScope(tenantId, crypto.randomUUID());
      const routeId = crypto.randomUUID();
      const admissionId = crypto.randomUUID();
      const key = Schema.decodeUnknownSync(AdmitSymmySyncPayloadSchema.fields.idempotencyKey)(
        'configured-stock-replay',
      );
      const keyDigest = yield* sha256Digest(key);
      const inventoryRef = inventoryRefFor(tenantId);
      const unitRef = {
        moduleId: 'commerce.catalog',
        resourceId: crypto.randomUUID(),
        resourceType: 'commerce.catalog.product-unit',
        tenantId,
      };
      const fixturePlan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
        inventoryBackendId: 'backend',
        inventorySource: {
          customerConfigurationId: 'configuration',
          externalScope: 'stock',
          issuer: { backendId: 'backend', backendKind: 'external_business_system' },
          locations: [{ locationKey: 'warehouse', stockLocationRef: inventoryRef('stock-location') }],
          namespace: 'stock',
          policyRef: inventoryRef('source-provisioning-policy'),
          unitRef,
        },
        items: [
          {
            effects: [
              {
                effectKey: 'stock',
                operation: {
                  entrypointKey: 'commerce.inventory.import-source-assertion',
                  moduleId: 'commerce.inventory',
                  schemaVersion: '1',
                },
                originalTarget: inventoryRef('stock-position'),
              },
            ],
            itemKey: 'stock',
            source: {
              entityKind: 'STOCK',
              issuerId: 'fixture',
              sourceNamespace: 'stock',
              sourceRecordId: 'SKU',
            },
          },
        ],
      });
      yield* Effect.addFinalizer(() =>
        admin
          .delete(symmySyncAdmissions)
          .where(eq(symmySyncAdmissions.tenantId, tenantId))
          .pipe(
            Effect.andThen(admin.delete(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, tenantId))),
            Effect.orDie,
          ),
      );
      yield* admin.insert(symmyJobRoutes).values({
        active: true,
        fixtureIds: ['INTERNAL_C14'],
        fixturePlan,
        mappingVersion: 'v1',
        principalId: scope.principalId,
        routeId,
        routeKey: 'inventoryStockBatch',
        routeRevision: 'r1',
        tenantId,
      });
      const [pinned] = yield* admin.execute<{ readonly plan: unknown }>(
        sql`select symmy_integration.pin_symmy_fixture_plan(
        ${JSON.stringify(Schema.encodeSync(SymmyFixtureExecutionPlanSchema)(fixturePlan))}::jsonb,
        ${tenantId}::uuid, ${routeId}::uuid, 'r1', 'v1') as plan`,
        'objects',
      );
      const plan = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)(pinned?.plan);
      yield* admin.insert(symmySyncAdmissions).values({
        admissionId,
        executionPlan: plan,
        idempotencyDigest: keyDigest,
        intentDigest: 'b'.repeat(64),
        mappingVersion: 'v1',
        principalId: scope.principalId,
        routeId,
        routeKey: 'inventoryStockBatch',
        routeRevision: 'r1',
        tenantId,
      });
      const context = (replayIdempotencyKey: string, caller = scope) =>
        withScopedStores(connections.runtime.connectionString, caller, (store) =>
          store.routeContext({ replayIdempotencyKey, routeKey: 'inventoryStockBatch' }),
        );
      // The actual producer supplies Shell's no-owner-read marker while the route is still configured.
      expect(yield* context(key)).toMatchObject({ allowedOwnerOperations: [], replayIdempotencyDigest: keyDigest });
      expect((yield* context('fresh-key')).replayIdempotencyDigest).toBeUndefined();
      expect(yield* context(key, makeScope(tenantId, crypto.randomUUID())).pipe(Effect.flip)).toMatchObject({
        code: 'route_denied',
      });
      const divergentRows = Schema.decodeUnknownSync(SymmyStockRowsSchema)([
        {
          businessObservedAt: '2026-01-01T00:00:00.000Z',
          itemKey: 'different-SKU',
          locationKey: 'warehouse',
          quantity: { amount: '1', unitRef },
          revision: '2',
          sourceReference: 'different',
        },
      ]);
      // Existing-key conflict is decided before fresh stockFacts, lifecycle setup or any Inventory lookup.
      const conflict = yield* withScopedStores(connections.runtime.connectionString, scope, (store) =>
        store.admitSync(
          {
            idempotencyKey: key,
            routeKey: 'inventoryStockBatch',
            stock: divergentRows,
          },
          crypto.randomUUID(),
        ),
      ).pipe(Effect.flip);
      expect(conflict).toMatchObject({ code: 'idempotency_conflict' });
      yield* admin
        .update(symmySyncAdmissions)
        .set({
          retentionReceipt: {
            authorityReceiptRef: 'purged',
            authorityRevision: '1',
            policyId: 'stock-retention',
            purgedAt: '2026-01-01T00:00:00.000Z',
            revision: '1',
          },
        })
        .where(eq(symmySyncAdmissions.admissionId, admissionId));
      expect(yield* context(key).pipe(Effect.flip)).toMatchObject({ code: 'route_denied' });
      expect((yield* context('fresh-key')).replayIdempotencyDigest).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);

it.live(
  'recovers seeded committed stock history from an inactive legacy stockScope route without executing new work',
  () =>
    Effect.gen(function* retiredStockHistory() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const owner = makeTestOperationOwner({ actions: [retiredReceiptProbe], moduleId: 'integration.symmy' });
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          access: 'allowed',
          actionKeys: [retiredReceiptProbeKey],
          adminConnectionString: Redacted.make(connections.admin.connectionString),
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          authenticationSubjectTypes: ['user', 'api_key'],
          compositionRevision: 'c'.repeat(64),
          managerAuthenticationMethod: 'api_key',
          moduleKeys: ['integration.symmy'],
          ownerRegistration: owner.ownerRegistration,
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      const { tenantId } = fixture;
      const caller: OperationalScope = {
        ...fixture.manager,
        audience: 'symmy-integration',
        correlationId: 'retired-stock-history',
      };
      const inventoryRef = inventoryRefFor(tenantId);
      const positionRef = inventoryRef('stock-position');
      const locationRef = inventoryRef('stock-location');
      const unitRef = {
        moduleId: 'commerce.catalog',
        resourceId: crypto.randomUUID(),
        resourceType: 'commerce.catalog.product-unit',
        tenantId,
      };
      const routeId = crypto.randomUUID();
      const admissionId = crypto.randomUUID();
      const importInvocationId = crypto.randomUUID();
      const retentionAdmissionId = crypto.randomUUID();
      const key = Schema.decodeUnknownSync(AdmitSymmySyncPayloadSchema.fields.idempotencyKey)('retired-native-stock');
      const retentionKey = Schema.decodeUnknownSync(AdmitSymmySyncPayloadSchema.fields.idempotencyKey)(
        'retired-native-stock-retention',
      );
      const rows = Schema.decodeUnknownSync(SymmyStockRowsSchema)([
        {
          businessObservedAt: '2026-01-01T00:00:00.000Z',
          itemKey: 'legacy-SKU',
          locationKey: 'warehouse',
          quantity: { amount: '12', unitRef },
          revision: '1',
          sourceReference: 'legacy-native-row',
        },
      ]);
      const qualification = {
        customerConfigurationId: 'legacy-configuration',
        externalScope: 'legacy-scope',
        issuer: { backendId: 'legacy-backend', backendKind: 'external_business_system' },
        namespace: 'legacy-stock',
      };
      const template = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
        inventoryBackendId: 'legacy-backend',
        inventorySource: {
          ...qualification,
          locations: [{ locationKey: 'warehouse', stockLocationRef: locationRef }],
          policyRef: inventoryRef('source-provisioning-policy'),
          unitRef,
        },
        items: [
          {
            effects: [{ effectKey: 'stock', operation: stockOperation }],
            itemKey: 'stock',
            source: {
              entityKind: 'STOCK',
              issuerId: 'legacy-source',
              sourceNamespace: 'legacy',
              sourceRecordId: 'enrollment',
            },
          },
        ],
      });
      const facts = Schema.decodeUnknownSync(SymmyStockPositionFactsSchema)([
        {
          request: { ...qualification, itemKey: 'legacy-SKU', locationKey: 'warehouse' },
          resolution: {
            _tag: 'RESOLVED',
            policyRef: template.inventorySource?.policyRef,
            positionRef,
            stockItemRef: inventoryRef('stock-item'),
            stockLocationRef: locationRef,
          },
        },
      ]);
      const originalPlan = Option.getOrThrow(
        yield* buildSymmyStockPlan({
          digest: sha256Digest,
          facts,
          idempotencyKey: key,
          receivedAt: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
          rows,
          template,
        }),
      );
      // Preserve the retired wire shape in storage. Neither public retry is allowed to decode it as current enrollment.
      const legacyTemplate = {
        inventoryBackendId: 'legacy-backend',
        items: template.items,
        stockScope: [
          {
            customerConfigurationId: qualification.customerConfigurationId,
            issuerBackendId: 'legacy-backend',
            itemKey: 'legacy-SKU',
            locationKey: 'warehouse',
            namespace: qualification.namespace,
            positionRef,
            scope: qualification.externalScope,
            unitRef,
          },
        ],
      };
      yield* admin.insert(symmyJobRoutes).values({
        active: false,
        fixtureIds: ['INTERNAL_C14'],
        fixturePlan: sql`${JSON.stringify(legacyTemplate)}::jsonb`,
        mappingVersion: 'v1',
        principalId: fixture.manager.principalId,
        routeId,
        routeKey: 'inventoryStockBatch',
        routeRevision: 'r1',
        tenantId,
      });
      const [pinned] = yield* admin.execute<{ readonly plan: unknown }>(
        sql`select symmy_integration.pin_symmy_fixture_plan(
        ${JSON.stringify(Schema.encodeSync(SymmyFixtureExecutionPlanSchema)(originalPlan))}::jsonb,
        ${tenantId}::uuid, ${routeId}::uuid, 'r1', 'v1') as plan`,
        'objects',
      );
      const importRequestHash = 'a'.repeat(64);
      const nativePlan = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)(pinned?.plan);
      const savedPlan = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
        ...nativePlan,
        items: nativePlan.items.map((item) => ({
          ...item,
          effects: item.effects.map((effect) => ({
            ...effect,
            authContextRef: fixture.manager.authContextRef,
            executorBindingIncarnation: crypto.randomUUID(),
            executorPrincipalId: fixture.manager.principalId,
            requestHash: importRequestHash,
          })),
        })),
      });
      const { effectId } = savedPlan.items[0].effects[0].ref;
      const keyDigest = yield* sha256Digest(key);
      const retentionKeyDigest = yield* sha256Digest(retentionKey);
      const intentDigest = yield* sha256Digest(
        JSON.stringify([
          'inventoryStockBatch',
          null,
          'INTERNAL_C14',
          Schema.encodeSync(Schema.fromJsonString(SymmyStockRowsSchema))(rows),
        ]),
      );
      // PG store/recovery proof: owner commit facts are seeded; Inventory execution and external key redemption are not.
      yield* admin.execute(sql`insert into core.action_invocations
      (action_invocation_id,tenant_id,principal_id,action_key,status,request_hash,auth_context_ref,idempotency_key)
      values
      (${admissionId}::uuid,${tenantId}::uuid,${fixture.manager.principalId}::uuid,
        'integration.symmy.admit-symmy-sync','succeeded',${'b'.repeat(64)},${fixture.manager.authContextRef},'original-admission'),
      (${retentionAdmissionId}::uuid,${tenantId}::uuid,${fixture.manager.principalId}::uuid,
        'integration.symmy.admit-symmy-sync','succeeded',${'c'.repeat(64)},${fixture.manager.authContextRef},'retention-admission'),
      (${importInvocationId}::uuid,${tenantId}::uuid,${fixture.manager.principalId}::uuid,
        'commerce.inventory.import-source-assertion','succeeded',${importRequestHash},${fixture.manager.authContextRef},${effectId})`);
      yield* admin.execute(sql`insert into core.source_execution_fences(tenant_id,admission_invocation_id,state)
      values (${tenantId}::uuid,${admissionId}::uuid,'open'), (${tenantId}::uuid,${retentionAdmissionId}::uuid,'open')`);
      yield* admin.insert(symmySyncAdmissions).values({
        admissionId,
        executionPlan: savedPlan,
        idempotencyDigest: keyDigest,
        intentDigest,
        mappingVersion: 'v1',
        principalId: fixture.manager.principalId,
        routeId,
        routeKey: 'inventoryStockBatch',
        routeRevision: 'r1',
        tenantId,
      });
      yield* admin.insert(symmySyncAdmissions).values({
        admissionId: retentionAdmissionId,
        executionPlan: savedPlan,
        idempotencyDigest: retentionKeyDigest,
        intentDigest,
        mappingVersion: 'v1',
        principalId: fixture.manager.principalId,
        routeId,
        routeKey: 'inventoryStockBatch',
        routeRevision: 'r1',
        tenantId,
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* cleanupRetiredStock() {
          yield* admin.delete(symmySyncAdmissionAttempts).where(eq(symmySyncAdmissionAttempts.tenantId, tenantId));
          yield* admin.delete(symmySyncAdmissions).where(eq(symmySyncAdmissions.tenantId, tenantId));
          yield* admin.delete(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, tenantId));
        }).pipe(Effect.orDie),
      );
      const context = (replayIdempotencyKey: string, scope = caller) =>
        withScopedStores(connections.runtime.connectionString, scope, (store) =>
          store.routeContext({ replayIdempotencyKey, routeKey: 'inventoryStockBatch' }),
        );
      const consume = (payload: typeof AdmitSymmySyncPayloadSchema.Type) =>
        runAction({
          payload,
          principal: fixture.manager,
          registration: retiredReceiptProbe,
          transport: {
            correlationId: crypto.randomUUID(),
            idempotencyKey: crypto.randomUUID(),
            targetModuleKey: 'integration.symmy',
          },
        }).pipe(Effect.provide(fixture.layer));
      const input = Schema.decodeUnknownSync(AdmitSymmySyncPayloadSchema)({
        idempotencyKey: key,
        routeKey: 'inventoryStockBatch',
        stock: rows,
      });
      expect(yield* context(key)).toMatchObject({
        allowedOwnerOperations: [],
        replayIdempotencyDigest: keyDigest,
        routeId,
      });
      const recovered = yield* consume(input);
      assert('plan' in recovered);
      expect(recovered).toMatchObject({ admissionId, replayed: true, tenantId });
      expect(recovered.plan.items[0].effects[0]).toMatchObject({
        originalInvocationId: importInvocationId,
        originalInvocationStatus: 'succeeded',
        ref: { effectId, originalTarget: positionRef },
      });
      const denied = (payload: typeof input) => consume(payload).pipe(Effect.flip);
      expect(yield* context('fresh-key').pipe(Effect.flip)).toMatchObject({ code: 'route_denied' });
      expect(
        yield* denied(
          Schema.decodeUnknownSync(AdmitSymmySyncPayloadSchema)({
            ...input,
            idempotencyKey: 'fresh-key',
          }),
        ),
      ).toMatchObject({ code: 'route_denied' });
      expect(
        yield* denied(
          Schema.decodeUnknownSync(AdmitSymmySyncPayloadSchema)({
            ...input,
            stock: [{ ...rows[0], revision: 'different' }],
          }),
        ),
      ).toMatchObject({ code: 'idempotency_conflict' });
      for (const foreign of [
        makeScope(tenantId, crypto.randomUUID()),
        makeScope(crypto.randomUUID(), fixture.manager.principalId),
        makeScope(tenantId, fixture.manager.principalId, fixture.legalEntityId),
        { ...caller, authMethod: 'session' as const },
      ]) {
        expect(yield* context(key, foreign).pipe(Effect.flip)).toMatchObject({ code: 'route_denied' });
        expect(
          yield* withScopedStores(connections.runtime.connectionString, foreign, (store) =>
            store.admitSync(input, crypto.randomUUID()),
          ).pipe(Effect.flip),
        ).toMatchObject({ code: 'route_denied' });
      }
      // A logical key cannot select between two historical enrollments, even if their payload digests match.
      const competingRouteId = crypto.randomUUID();
      const competingAdmissionId = crypto.randomUUID();
      yield* admin.insert(symmyJobRoutes).values({
        active: false,
        fixtureIds: ['INTERNAL_C14'],
        fixturePlan: sql`${JSON.stringify(legacyTemplate)}::jsonb`,
        legalEntityId: fixture.legalEntityId,
        mappingVersion: 'v1',
        principalId: fixture.manager.principalId,
        routeId: competingRouteId,
        routeKey: 'inventoryStockBatch',
        routeRevision: 'r1',
        tenantId,
      });
      yield* admin.insert(symmySyncAdmissions).values({
        admissionId: competingAdmissionId,
        executionPlan: savedPlan,
        idempotencyDigest: keyDigest,
        intentDigest,
        legalEntityId: fixture.legalEntityId,
        mappingVersion: 'v1',
        principalId: fixture.manager.principalId,
        routeId: competingRouteId,
        routeKey: 'inventoryStockBatch',
        routeRevision: 'r1',
        tenantId,
      });
      expect(yield* context(key).pipe(Effect.flip)).toMatchObject({ code: 'route_denied' });
      // The company-free producer cannot choose a route. An already scoped consumer still names one exact identity.
      expect(yield* consume(input)).toMatchObject({ admissionId, replayed: true });
      yield* admin.delete(symmySyncAdmissions).where(eq(symmySyncAdmissions.admissionId, competingAdmissionId));
      yield* admin.delete(symmyJobRoutes).where(eq(symmyJobRoutes.routeId, competingRouteId));
      yield* admin
        .update(symmyJobRoutes)
        .set({ mappingVersion: 'replaced' })
        .where(eq(symmyJobRoutes.routeId, routeId));
      expect(yield* context(key).pipe(Effect.flip)).toMatchObject({ code: 'route_denied' });
      expect(yield* denied(input)).toMatchObject({ code: 'route_denied' });
      yield* admin.update(symmyJobRoutes).set({ mappingVersion: 'v1' }).where(eq(symmyJobRoutes.routeId, routeId));
      // An open admission fence is not enough to execute an effect which never committed.
      yield* admin.execute(
        sql`update core.action_invocations set status='running' where action_invocation_id=${importInvocationId}::uuid`,
      );
      expect(yield* denied(input)).toMatchObject({ code: 'route_denied' });
      yield* admin.execute(
        sql`update core.action_invocations set status='succeeded' where action_invocation_id=${importInvocationId}::uuid`,
      );
      yield* admin.execute(
        sql`update core.source_execution_fences set state='cancelled' where admission_invocation_id=${admissionId}::uuid`,
      );
      expect(yield* denied(input)).toMatchObject({ code: 'route_denied' });
      // Retention has its own open fence; cancellation of the other admission cannot mask this denial.
      const retentionInput = { ...input, idempotencyKey: retentionKey };
      expect(yield* context(retentionKey)).toMatchObject({ replayIdempotencyDigest: retentionKeyDigest });
      expect(yield* consume(retentionInput)).toMatchObject({ admissionId: retentionAdmissionId, replayed: true });
      yield* admin
        .update(symmySyncAdmissions)
        .set({
          retentionReceipt: {
            authorityReceiptRef: 'purged',
            authorityRevision: '1',
            policyId: 'legacy-stock',
            purgedAt: '2026-01-01T00:00:00.000Z',
            revision: '1',
          },
        })
        .where(eq(symmySyncAdmissions.admissionId, retentionAdmissionId));
      expect(yield* context(retentionKey).pipe(Effect.flip)).toMatchObject({ code: 'route_denied' });
      expect(yield* denied(retentionInput)).toMatchObject({ code: 'route_denied' });
      const [counts] = yield* admin.execute<{
        readonly active: boolean;
        readonly admissions: number;
        readonly effects: number;
        readonly imports: number;
        readonly writers: number;
      }>(
        sql`select
      (select active from symmy_integration.job_routes where route_id=${routeId}::uuid) as active,
      (select count(*)::integer from symmy_integration.sync_admissions where tenant_id=${tenantId}::uuid) as admissions,
      (select count(*)::integer from symmy_integration.job_effects where tenant_id=${tenantId}::uuid) as effects,
      (select count(*)::integer from core.action_invocations where tenant_id=${tenantId}::uuid
        and action_key='commerce.inventory.import-source-assertion') as imports,
      (select count(*)::integer from core.access_workload_bindings where tenant_id=${tenantId}::uuid
        and workload_key='commerce.inventory.source-write' and status='active') as writers`,
        'objects',
      );
      expect(counts).toEqual({ active: false, admissions: 2, effects: 0, imports: 1, writers: 0 });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer, Reactivity.layer))),
);

it.effect('pins eight unsupported product branches and still rejects nine or a foreign target', () =>
  Effect.gen(function* pinUnsupportedBranches() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const admin = yield* openDatabase(connections.admin.connectionString);
    const tenantId = crypto.randomUUID();
    const routeId = crypto.randomUUID();
    const kinds = [
      'CategoryHint',
      'AttributeHint',
      'MediaHint',
      'VariantUpdateHint',
      'DescriptiveHint',
      'ClassificationHint',
      'PriceHint',
      'StockProvisioningHint',
    ] as const;
    const branches = kinds.map((kind) => ({ branchKey: kind, kind }));
    const plan = {
      items: [
        {
          effects: [
            {
              effectKey: 'create',
              operation: {
                entrypointKey: 'commerce.catalog.create-product',
                moduleId: 'commerce.catalog',
                schemaVersion: '2',
              },
            },
          ],
          itemKey: 'product',
          source: {
            entityKind: 'PRODUCT',
            issuerId: 'fixture',
            sourceNamespace: 'catalog',
            sourceRecordId: 'product',
          },
          unsupportedBranches: branches,
        },
      ],
    };
    const pin = (value: typeof Schema.Json.Type) =>
      admin.execute<{ readonly plan: unknown }>(
        sql`select symmy_integration.pin_symmy_fixture_plan(
          ${JSON.stringify(value)}::jsonb, ${tenantId}::uuid, ${routeId}::uuid, 'r1', 'v1') as plan`,
        'objects',
      );
    const valid = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)(plan);
    const [row] = yield* pin(
      Schema.decodeUnknownSync(Schema.Json)(Schema.encodeSync(SymmyFixtureExecutionPlanSchema)(valid)),
    );
    const pinned = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)(row?.plan);
    const actual = pinned.items[0]?.unsupportedBranches;
    expect(actual?.map(({ branchKey, kind }) => ({ branchKey, kind }))).toEqual(branches);
    expect(new Set(actual?.map(({ branchId }) => branchId)).size).toBe(8);

    const [item] = plan.items;
    assert.isDefined(item);
    const nine = {
      ...plan,
      items: [{ ...item, unsupportedBranches: [...branches, { branchKey: 'TaxHint', kind: 'TaxHint' }] }],
    };
    const failure = yield* pin(nine).pipe(Effect.flip);
    expect(Option.getOrThrow(findPostgresFailure(failure))).toMatchObject({ code: '22023' });

    const [effect] = item.effects;
    assert.isDefined(effect);
    const foreign = {
      ...plan,
      items: [
        {
          ...item,
          effects: [
            {
              ...effect,
              originalTarget: {
                moduleId: 'commerce.catalog',
                resourceId: crypto.randomUUID(),
                resourceType: 'commerce.catalog.product',
                tenantId: crypto.randomUUID(),
              },
            },
          ],
        },
      ],
    };
    const scopeFailure = yield* pin(foreign).pipe(Effect.flip);
    expect(Option.getOrThrow(findPostgresFailure(scopeFailure))).toMatchObject({ code: '22023' });
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);
