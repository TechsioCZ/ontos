import { expect, it } from 'effect-rstest';
import { eq, inArray, sql } from 'drizzle-orm';
import { Effect, Predicate, Schema } from 'effect';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { applicationCompositionAuthority, coreRelations, legalEntities, tenants } from '../../src/db/schema.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import { lockApplicationCompositionPublication } from '../../src/modules/application-composition-authority.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { defineScopedRoutine } from '../../src/db/scoped-routine.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  makeOutboxWorkerLegalEntityScopeFanout,
  makePostgresOutboxWorkerLegalEntityScopeBackend,
} from '../../src/outbox/legal-entity-scope-fanout.ts';

const tenantId = '12000000-0000-4000-8000-000000000001';
const otherTenantId = '12000000-0000-4000-8000-000000000002';
const legalEntityOne = '22000000-0000-4000-8000-000000000001';
const legalEntityTwo = '22000000-0000-4000-8000-000000000002';
const suspended = '22000000-0000-4000-8000-000000000003';
const foreign = '22000000-0000-4000-8000-000000000004';

const rollbackProbeRoutine = defineScopedRoutine({
  name: 'create_term',
  ownerModuleKey: 'payment.term-catalog',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ payload: Schema.Unknown }),
  routineKey: 'catalog.create',
  schema: 'payment_term_catalog',
});

class OwnerProbeFailure extends Schema.TaggedError<OwnerProbeFailure>()('OwnerProbeFailure', {
  reason: Schema.String,
}) {}

const CreatedPaymentTermPayloadSchema = Schema.TaggedStruct('created', {});

const compositionRevision = 'a'.repeat(64);
const promotedRevision = 'b'.repeat(64);

const context = attestOutboxWorkerHandlerContext({
  actorPrincipalId: '32000000-0000-4000-8000-000000000001',
  attemptNumber: 1,
  claimId: 'claim-1',
  compositionRevision,
  consumerModuleKey: 'commerce.customer-context',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  legalEntityScope: 'required',
  messageId: 'message-1',
  producerModuleKey: 'party.registry',
  tenantId,
  tenantSequenceNo: 10n,
  topic: 'party.registry.party-merged.v1',
  workerKey: 'commerce.customer-context.reconcile-party-merge',
});

it.live('runs owner callbacks once inside every current legal-entity scope of the exact Tenant', () =>
  Effect.gen(function* legalEntityFanoutIntegration() {
    const configuration = yield* loadDatabaseConfig();
    const database = yield* makeCoreDatabase(configuration);
    const connections = yield* loadDatabaseConnectionPair();
    const admin = yield* makeTestPgClient(connections.admin.connectionString);
    const adminDatabase = yield* makeTestDatabaseFromClient(admin, coreRelations);
    yield* Effect.acquireRelease(
      adminDatabase.transaction(
        Effect.fn('seedFanoutCompositionAuthority')(function* seedFanoutAuthority(transaction: CoreTransaction) {
          yield* lockApplicationCompositionPublication(transaction);
          const [previous] = yield* transaction
            .select()
            .from(applicationCompositionAuthority)
            .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
          const authority = {
            authorityKey: 'active',
            phase: 'active',
            revision: compositionRevision,
            subscriptionsJson: [],
            validUntil: sql`clock_timestamp() + interval '1 hour'`,
          } as const;
          yield* transaction.insert(applicationCompositionAuthority).values(authority).onConflictDoUpdate({
            set: authority,
            target: applicationCompositionAuthority.authorityKey,
          });
          return previous;
        }),
      ),
      (previous) =>
        adminDatabase
          .transaction(
            Effect.fn('restoreFanoutCompositionAuthority')(function* restoreFanoutAuthority(
              transaction: CoreTransaction,
            ) {
              yield* lockApplicationCompositionPublication(transaction);
              yield* transaction
                .delete(applicationCompositionAuthority)
                .where(inArray(applicationCompositionAuthority.revision, [compositionRevision, promotedRevision]));
              if (previous !== undefined) {
                yield* transaction.insert(applicationCompositionAuthority).values(previous);
              }
            }),
          )
          .pipe(Effect.orDie),
    );
    const cleanup = Effect.gen(function* cleanupFanoutFixtures() {
      yield* database.executor.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
      yield* database.executor.delete(legalEntities).where(eq(legalEntities.tenantId, otherTenantId));
      yield* database.executor.delete(tenants).where(eq(tenants.tenantId, tenantId));
      yield* database.executor.delete(tenants).where(eq(tenants.tenantId, otherTenantId));
    });
    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* database.executor.insert(tenants).values([
      {
        defaultLocale: 'en',
        name: 'Worker fanout tenant',
        slug: 'worker-fanout-tenant',
        status: 'active',
        tenantId,
      },
      {
        defaultLocale: 'en',
        name: 'Worker fanout foreign tenant',
        slug: 'worker-fanout-foreign-tenant',
        status: 'active',
        tenantId: otherTenantId,
      },
    ]);
    yield* database.executor.insert(legalEntities).values([
      {
        legalEntityId: legalEntityTwo,
        legalName: 'Second entity',
        registrationCountry: 'CZ',
        registrationNumber: 'WORKER-FANOUT-2',
        status: 'active',
        tenantId,
      },
      {
        legalEntityId: legalEntityOne,
        legalName: 'First entity',
        registrationCountry: 'CZ',
        registrationNumber: 'WORKER-FANOUT-1',
        status: 'active',
        tenantId,
      },
      {
        legalEntityId: suspended,
        legalName: 'Suspended entity',
        registrationCountry: 'CZ',
        registrationNumber: 'WORKER-FANOUT-3',
        status: 'suspended',
        tenantId,
      },
      {
        legalEntityId: foreign,
        legalName: 'Foreign entity',
        registrationCountry: 'CZ',
        registrationNumber: 'WORKER-FANOUT-4',
        status: 'active',
        tenantId: otherTenantId,
      },
    ]);
    const observed: string[] = [];
    const fanout = makeOutboxWorkerLegalEntityScopeFanout(makePostgresOutboxWorkerLegalEntityScopeBackend(database));
    yield* fanout.forEachScope(context, (scope) => {
      expect(scope.tenantId).toBe(tenantId);
      observed.push(scope.legalEntityId);
      return Effect.void;
    });
    expect(observed).toEqual([legalEntityOne, legalEntityTwo, suspended]);

    const rollbackProbeInput = {
      actingPrincipalId: '32000000-0000-4000-8000-000000000001',
      actionInvocationId: '42000000-0000-4000-8000-000000000001',
      activeFrom: '2026-09-09T00:00:00.000Z',
      businessCode: 'WORKER_ROLLBACK_PROBE',
      compatibilityKey: 'worker-rollback-probe-v1',
      displayName: 'Worker rollback probe',
      explanation: 'Proves that owner failure rolls back the owner routine write',
      paymentTermId: '52000000-0000-4000-8000-000000000001',
      reason: 'Core fan-out transaction rollback integration evidence',
      semantics: {
        calculationRuleVersion: 2,
        calendarRule: 'NOT_APPLICABLE',
        kind: 'IMMEDIATE',
      },
    } as const;
    const ownerFailure = yield* Effect.flip(
      fanout.forEachScope(context, (scope) =>
        scope.routineInvoker
          .invoke(rollbackProbeRoutine, [rollbackProbeInput])
          .pipe(Effect.andThen(Effect.fail(new OwnerProbeFailure({ reason: 'fail after the owner write' })))),
      ),
    );
    expect(Schema.is(OwnerProbeFailure)(ownerFailure)).toBe(true);
    let retryPayload: unknown;
    yield* Effect.flip(
      fanout.forEachScope(context, (scope) =>
        scope.routineInvoker.invoke(rollbackProbeRoutine, [rollbackProbeInput]).pipe(
          Effect.tap(([row]) =>
            Effect.sync(() => {
              retryPayload = row?.payload;
            }),
          ),
          Effect.andThen(Effect.fail(new OwnerProbeFailure({ reason: 'roll back the evidence retry too' }))),
        ),
      ),
    );
    expect(Schema.is(CreatedPaymentTermPayloadSchema)(retryPayload)).toBe(true);

    // A new cycle may admit the unchanged owner under B; an already claimed A context
    // cannot adopt B when it later attempts an owner transaction.
    yield* adminDatabase.transaction(
      Effect.fn('promoteFanoutCompositionAuthority')(function* promoteFanoutAuthority(transaction: CoreTransaction) {
        yield* lockApplicationCompositionPublication(transaction);
        yield* transaction
          .update(applicationCompositionAuthority)
          .set({ revision: promotedRevision, validUntil: sql`clock_timestamp() + interval '1 hour'` })
          .where(eq(applicationCompositionAuthority.revision, compositionRevision));
      }),
    );
    let staleCallbacks = 0;
    const staleFailure = yield* fanout
      .forEachScope(context, () =>
        Effect.sync(() => {
          staleCallbacks += 1;
        }),
      )
      .pipe(Effect.flip);
    expect(Predicate.isTagged(staleFailure, 'OutboxWorkerLegalEntityScopeError')).toBe(true);
    expect(staleCallbacks).toBe(0);
    expect(context.compositionRevision).toBe(compositionRevision);
    const nextContext = attestOutboxWorkerHandlerContext({
      ...context,
      claimId: 'claim-2',
      compositionRevision: promotedRevision,
      deliveryId: 'delivery-2',
    });
    const promotedScopes: string[] = [];
    yield* fanout.forEachScope(nextContext, (scope) =>
      Effect.sync(() => {
        promotedScopes.push(scope.legalEntityId);
      }),
    );
    expect(promotedScopes).toEqual([legalEntityOne, legalEntityTwo, suspended]);
  }),
);
