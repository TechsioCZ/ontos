import type { OperationalScope } from '@app/core-runtime';
import { findPostgresFailure, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { PricingDiscountIdentityKeySchema } from '@app/pricing-contracts/domain/discount';
import type {
  ExpectedPricingDiscountCurrent,
  PricingDiscountScheduleSnapshot,
} from '@app/pricing-contracts/domain/discount';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type {
  ContractualDiscountPersistence,
  ManageContractualDiscountPersistenceCommand,
} from '../../src/services/contractual-discount-persistence.service.ts';
import { contractualDiscountPersistenceForScope } from '../../src/services/contractual-discount-persistence.service.ts';

const tenantId = 'e7970000-0000-4000-8000-000000000001';
const legalEntityId = 'e7970000-0000-4000-8000-000000000002';
const principalId = 'e7970000-0000-4000-8000-000000000003';
const otherPrincipalId = 'e7970000-0000-4000-8000-000000000004';
const initialAt = '2026-09-27T10:00:00.000Z';
const editAt = '2026-09-27T10:30:00.000Z';
const currentPeriod = { effectiveFrom: '2026-09-27T09:00:00.000Z', effectiveTo: '2026-09-27T12:00:00.000Z' };
const futurePeriod = { effectiveFrom: '2026-09-27T14:00:00.000Z', effectiveTo: '2026-09-27T16:00:00.000Z' };

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];
type ContractualDiscountGenerationVerification = Parameters<ContractualDiscountPersistence['verifySetGeneration']>[0];
interface RawContractualDiscountGenerationVerification {
  readonly authority: ContractualDiscountGenerationVerification['authority'];
  readonly predicate: ContractualDiscountGenerationVerification['predicate'];
  readonly through?: ContractualDiscountGenerationVerification['through'] | null;
}

const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const identityKey = Schema.decodeSync(PricingDiscountIdentityKeySchema)({
  audience: {
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: 'e7970000-0000-4000-8000-000000000005',
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    kind: 'COUNTERPARTY',
  },
  basis: { kind: 'WHOLE_PURCHASE' },
  commercialScope: { channelId: 'B2B', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  effectKind: 'FIXED_MONETARY_AMOUNT',
  family: 'CONTRACTUAL_DISCOUNT',
  monetaryBoundary: 'PRE_TAX',
  scope: 'WHOLE_PURCHASE',
});
const scopeFor = (actingPrincipalId = principalId): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'e7970000-0000-4000-8000-000000000006',
    authContextRef: 'better-auth-session:contractual-discount-postgres',
    authMethod: 'session',
    legalEntityId,
    principalId: actingPrincipalId,
    tenantId,
  }),
  correlationId: 'contractual-discount-postgres',
});

const withPersistence = <Value, Failure>(
  database: PricingTestDatabase,
  operation: (persistence: ContractualDiscountPersistence) => Effect.Effect<Value, Failure>,
  actingPrincipalId = principalId,
) =>
  database.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* scopedContractualDiscountPersistence() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
        'objects',
      );
      const scope = scopeFor(actingPrincipalId);
      const ownerTransaction = yield* installOperationalScope(transaction, scope);
      const persistence = yield* contractualDiscountPersistenceForScope(ownerTransaction, scope);
      return yield* operation(persistence);
    }),
  );

const verifySetGenerationRaw = (database: PricingTestDatabase, input: RawContractualDiscountGenerationVerification) =>
  database.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* invokeContractualDiscountGenerationVerification() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
        'objects',
      );
      yield* installOperationalScope(transaction, scopeFor());
      const encodedInput = yield* encodeJson(input);
      return yield* transaction.execute<{ readonly payload: unknown }>(
        sql`select payload from pricing.verify_contractual_discount_set_generation_v1(
          ${tenantId}::uuid,
          ${legalEntityId}::uuid,
          ${encodedInput}::jsonb
        )`,
        'objects',
      );
    }),
  );

const cleanup = (admin: PricingTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupContractualDiscount() {
      yield* transaction.execute(
        sql`delete from pricing.contractual_discount_schedule_acknowledgements where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.contractual_discount_action_invocation_receipts where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.contractual_discount_schedule_heads where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.contractual_discount_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.contractual_discounts where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(
        sql`delete from pricing.contractual_discount_set_heads where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.material_evidence_proof_receipts
             where tenant_id = ${tenantId}::uuid and family = 'DISCOUNT'`,
      );
      yield* transaction.execute(
        sql`delete from pricing.contractual_discount_set_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.contractual_discount_set_roots where tenant_id = ${tenantId}::uuid`,
      );
    }),
  );

const createCommand = (actionInvocationId: string, amount: string): ManageContractualDiscountPersistenceCommand => ({
  actingPrincipalId: principalId,
  actionInvocationId,
  configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount, currencyCode: 'CZK' } },
  effectivePeriod: currentPeriod,
  expectedState: { state: 'ABSENT' },
  identityKey,
  intent: 'CREATE',
  reason: 'Create an exact contractual benefit',
  requestCorrelationId: actionInvocationId,
  trustedOperationAt: instant(initialAt),
});

const expectedCurrentFrom = (schedule: PricingDiscountScheduleSnapshot): ExpectedPricingDiscountCurrent => {
  const { current } = schedule;
  if (current === undefined) {
    throw new Error('Expected an effective contractual Discount');
  }
  return {
    discountId: schedule.discountId,
    effectivePeriod: current.effectivePeriod,
    identityKey: schedule.identityKey,
    revision: current.definition.revision.revision,
    revisionId: current.definition.revision.revisionId,
    scheduleRevision: schedule.scheduleRevision,
  };
};

it.effect('persists exact Discount set proof refs and resolves the original generation through its fence', () =>
  Effect.gen(function* verifyDurableSetProof() {
    const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
    const database = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
    const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
    yield* cleanup(admin);
    const proofCreateCommand = createCommand('e7970000-0000-4000-8000-000000000080', '100');
    if (proofCreateCommand.intent !== 'CREATE') {
      throw new Error('Expected the proof fixture to use the create command');
    }
    const created = yield* withPersistence(database, (persistence) =>
      persistence.manage({
        ...proofCreateCommand,
        effectivePeriod: { effectiveFrom: currentPeriod.effectiveFrom, effectiveTo: null },
      }),
    );
    if (created.outcome !== 'CONTRACTUAL_DISCOUNT_CREATED' && created.outcome !== 'CONTRACTUAL_DISCOUNT_REUSED') {
      throw new Error('Expected the proof fixture Discount to exist');
    }
    const predicate = {
      audiences: [identityKey.audience],
      basis: identityKey.basis,
      commercialScope: identityKey.commercialScope,
      currencyCode: identityKey.currencyCode,
      effectiveAt: initialAt,
      tenantId,
    } as const;
    const currentSet = yield* withPersistence(database, (persistence) => persistence.readCurrentSet(predicate));
    expect(currentSet.authority.observedAt).not.toBe(predicate.effectiveAt);
    expect(currentSet.currentDiscounts).toHaveLength(1);
    expect(currentSet.factProofs).toEqual([
      expect.objectContaining({
        factRef: currentSet.currentDiscounts[0]?.definition.discountId,
        factRevisionRef: currentSet.currentDiscounts[0]?.definition.revision.revisionId,
      }),
    ]);
    const resolved = yield* withPersistence(database, (persistence) =>
      persistence.resolveOriginalSetProof({ verificationRef: currentSet.authority.verificationRef }),
    );
    expect(resolved).toEqual({
      authority: currentSet.authority,
      currentFacts: currentSet.factProofs,
      outcome: 'CONTRACTUAL_DISCOUNT_SET_PROOF_RESOLVED',
      predicate: currentSet.predicate,
    });
    const verified = yield* withPersistence(database, (persistence) =>
      persistence.verifySetGeneration({
        authority: resolved.authority,
        predicate: resolved.predicate,
        through: resolved.authority.observedAt,
      }),
    );
    expect(verified).toEqual({
      authority: currentSet.authority,
      outcome: 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CURRENT',
      verifiedThrough: currentSet.authority.observedAt,
    });
    const verificationWithoutThrough = yield* Effect.exit(
      verifySetGenerationRaw(database, {
        authority: resolved.authority,
        predicate: resolved.predicate,
      }),
    );
    expect(Exit.isFailure(verificationWithoutThrough)).toBe(true);
    const verificationWithNullThrough = yield* Effect.exit(
      verifySetGenerationRaw(database, {
        authority: resolved.authority,
        predicate: resolved.predicate,
        through: null,
      }),
    );
    expect(Exit.isFailure(verificationWithNullThrough)).toBe(true);
    yield* withPersistence(database, (persistence) =>
      persistence.manage({
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000081',
        configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '110', currencyCode: 'CZK' } },
        expectedCurrent: expectedCurrentFrom(created.schedule),
        identityKey,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Advance the owner generation after the original proof',
        requestCorrelationId: 'e7970000-0000-4000-8000-000000000081',
        trustedOperationAt: instant(editAt),
      }),
    );
    const changed = yield* withPersistence(database, (persistence) =>
      persistence.verifySetGeneration({
        authority: resolved.authority,
        predicate: resolved.predicate,
        through: resolved.authority.observedAt,
      }),
    );
    expect(changed).toEqual({
      outcome: 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CHANGED',
      verifiedThrough: currentSet.authority.observedAt,
    });
  }),
);

it.live('serializes first-create races and exposes principal-bound original results', () =>
  Effect.scoped(
    Effect.gen(function* firstCreateRace() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const firstId = 'e7970000-0000-4000-8000-000000000010';
      const secondId = 'e7970000-0000-4000-8000-000000000011';
      const [first, second] = yield* Effect.all(
        [
          withPersistence(runtime, (persistence) => persistence.manage(createCommand(firstId, '10'))),
          withPersistence(runtime, (persistence) => persistence.manage(createCommand(secondId, '10'))),
        ],
        { concurrency: 2 },
      );
      expect([first.outcome, second.outcome].toSorted()).toEqual([
        'CONTRACTUAL_DISCOUNT_CONFLICT',
        'CONTRACTUAL_DISCOUNT_CREATED',
      ]);
      expect([first, second].find(({ outcome }) => outcome === 'CONTRACTUAL_DISCOUNT_CONFLICT')).toMatchObject({
        outcome: 'CONTRACTUAL_DISCOUNT_CONFLICT',
        reason: 'EXPECTED_CURRENT_STALE',
      });
      const counts = yield* admin.execute<{
        readonly discountCount: number;
        readonly generation: number;
        readonly revisionCount: number;
      }>(
        sql`select
              (select count(*)::integer from pricing.contractual_discounts where tenant_id = ${tenantId}::uuid) as "discountCount",
              (select count(*)::integer from pricing.contractual_discount_revisions where tenant_id = ${tenantId}::uuid) as "revisionCount",
              (select generation from pricing.contractual_discount_set_heads where tenant_id = ${tenantId}::uuid) as generation`,
        'objects',
      );
      expect(counts).toEqual([{ discountCount: 1, generation: 1, revisionCount: 1 }]);

      const found = yield* withPersistence(runtime, (persistence) =>
        persistence.lookupResult({ actionInvocationId: firstId }),
      );
      expect(found).toMatchObject({
        actionInvocationId: firstId,
        outcome: 'CONTRACTUAL_DISCOUNT_RESULT_FOUND',
        result: first,
      });
      const otherPrincipal = yield* withPersistence(
        runtime,
        (persistence) => persistence.lookupResult({ actionInvocationId: firstId }),
        otherPrincipalId,
      );
      expect(otherPrincipal).toEqual({ actionInvocationId: firstId, outcome: 'CONTRACTUAL_DISCOUNT_RESULT_ABSENT' });
    }),
  ),
);

it.live('rejects wrong-Tenant routine parameters at the runtime RLS fence', () =>
  Effect.scoped(
    Effect.gen(function* wrongTenantScope() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const wrongTenantId = 'e7970000-0000-4000-8000-000000000099';
      const command = createCommand('e7970000-0000-4000-8000-000000000019', '10');
      if (command.identityKey.audience.kind !== 'COUNTERPARTY') {
        throw new Error('Expected the contractual Discount fixture to target one Counterparty');
      }
      const crossTenantCommand = {
        ...command,
        identityKey: {
          ...command.identityKey,
          audience: {
            ...command.identityKey.audience,
            counterpartyRef: { ...command.identityKey.audience.counterpartyRef, tenantId: wrongTenantId },
          },
        },
      };
      const encoded = yield* encodeJson(crossTenantCommand);
      const failure = yield* runtime
        .transaction((transaction) =>
          Effect.gen(function* invokeWithWrongTenantParameter() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                         set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              'objects',
            );
            return yield* transaction.execute(
              sql`select payload from pricing.manage_contractual_discount_v1(
                    ${wrongTenantId}::uuid, ${legalEntityId}::uuid, ${encoded}::jsonb)`,
              'objects',
            );
          }),
        )
        .pipe(Effect.flip);
      expect(Option.getOrUndefined(findPostgresFailure(failure))?.code).toBe('42501');

      const wrongTenantRows = yield* admin.execute<{ readonly count: number }>(
        sql`select count(*)::integer as count from pricing.contractual_discounts
            where tenant_id = ${wrongTenantId}::uuid`,
        'objects',
      );
      expect(wrongTenantRows).toEqual([{ count: 0 }]);
    }),
  ),
);

it.live('creates an immutable successor when the value is unchanged but the effective boundary changes', () =>
  Effect.scoped(
    Effect.gen(function* sameValueSuccessor() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const created = yield* withPersistence(runtime, (persistence) =>
        persistence.manage(createCommand('e7970000-0000-4000-8000-000000000012', '10')),
      );
      if (created.outcome !== 'CONTRACTUAL_DISCOUNT_CREATED') {
        throw new Error('Expected the initial contractual Discount');
      }
      const revised = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000013',
          configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '10', currencyCode: 'CZK' } },
          expectedCurrent: expectedCurrentFrom(created.schedule),
          identityKey,
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Preserve the value while changing the exact successor boundary',
          requestCorrelationId: 'contractual-discount-same-value-successor',
          trustedOperationAt: instant(editAt),
        }),
      );
      expect(revised.outcome).toBe('CONTRACTUAL_DISCOUNT_REVISED');
      if (revised.outcome !== 'CONTRACTUAL_DISCOUNT_REVISED') {
        throw new Error('Expected a same-value successor Revision');
      }
      expect(revised.schedule.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: currentPeriod.effectiveFrom, effectiveTo: editAt },
        { effectiveFrom: editAt, effectiveTo: currentPeriod.effectiveTo },
      ]);
      expect(revised.schedule.revisions.map(({ definition }) => definition.revision.configuredEffect)).toEqual([
        { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '10', currencyCode: 'CZK' } },
        { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '10', currencyCode: 'CZK' } },
      ]);
    }),
  ),
);

it.live('schedules an immutable future Revision with exact head and receipt replay fences', () =>
  Effect.scoped(
    Effect.gen(function* scheduledRevision() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const created = yield* withPersistence(runtime, (persistence) =>
        persistence.manage(createCommand('e7970000-0000-4000-8000-000000000014', '10')),
      );
      if (created.outcome !== 'CONTRACTUAL_DISCOUNT_CREATED' || created.schedule.current === undefined) {
        throw new Error('Expected the initial Current contractual Discount');
      }
      const scheduleCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000015',
        configuredEffect: {
          kind: 'FIXED_MONETARY_AMOUNT' as const,
          level: { amount: '15', currencyCode: 'CZK' },
        },
        effectivePeriod: futurePeriod,
        expectedScheduleRevision: created.schedule.scheduleRevision,
        identityKey,
        intent: 'SCHEDULE_REVISION' as const,
        reason: 'Schedule the next exact contractual benefit interval',
        requestCorrelationId: 'contractual-discount-schedule-revision',
        trustedOperationAt: instant(initialAt),
      };
      const scheduled = yield* withPersistence(runtime, (persistence) => persistence.manage(scheduleCommand));
      expect(scheduled.outcome).toBe('CONTRACTUAL_DISCOUNT_REVISED');
      if (scheduled.outcome !== 'CONTRACTUAL_DISCOUNT_REVISED') {
        throw new Error('Expected a scheduled contractual Discount Revision');
      }
      expect(scheduled.schedule.scheduleRevision).toBe(2);
      expect(scheduled.schedule.future).toHaveLength(1);
      expect(scheduled.schedule.future[0]).toMatchObject({
        definition: {
          revision: {
            configuredEffect: scheduleCommand.configuredEffect,
            effectiveFrom: futurePeriod.effectiveFrom,
            revision: 2,
          },
        },
        effectivePeriod: futurePeriod,
        lineage: {
          correctedRevisionId: null,
          kind: 'SCHEDULED',
          previousRevisionId: created.schedule.current.definition.revision.revisionId,
        },
      });

      const immutablePrior = yield* admin.execute<{ readonly schedule: unknown }>(
        sql`select schedule from pricing.contractual_discount_revisions
            where tenant_id = ${tenantId}::uuid and discount_id = ${created.schedule.discountId}::uuid
              and schedule_revision = 1`,
        'objects',
      );
      expect(immutablePrior).toEqual([{ schedule: created.schedule }]);

      const replayed = yield* withPersistence(runtime, (persistence) => persistence.manage(scheduleCommand));
      expect(replayed).toEqual(scheduled);
      const mismatchedReplay = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          ...scheduleCommand,
          configuredEffect: {
            kind: 'FIXED_MONETARY_AMOUNT',
            level: { amount: '16', currencyCode: 'CZK' },
          },
        }),
      );
      expect(mismatchedReplay).toMatchObject({
        outcome: 'CONTRACTUAL_DISCOUNT_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });

      const stale = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          ...scheduleCommand,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000016',
          requestCorrelationId: 'contractual-discount-stale-schedule-revision',
        }),
      );
      expect(stale).toMatchObject({
        outcome: 'CONTRACTUAL_DISCOUNT_CONFLICT',
        reason: 'EXPECTED_SCHEDULE_STALE',
      });
      const overlapping = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          ...scheduleCommand,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000017',
          effectivePeriod: {
            effectiveFrom: '2026-09-27T11:00:00.000Z',
            effectiveTo: '2026-09-27T13:00:00.000Z',
          },
          expectedScheduleRevision: scheduled.schedule.scheduleRevision,
          requestCorrelationId: 'contractual-discount-overlapping-schedule-revision',
        }),
      );
      expect(overlapping).toMatchObject({
        outcome: 'CONTRACTUAL_DISCOUNT_CONFLICT',
        reason: 'OVERLAPPING_SCHEDULE',
      });
      const crossedBoundary = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          ...scheduleCommand,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000018',
          effectivePeriod: { effectiveFrom: initialAt, effectiveTo: initialAt },
          expectedScheduleRevision: scheduled.schedule.scheduleRevision,
          requestCorrelationId: 'contractual-discount-crossed-schedule-boundary',
        }),
      );
      expect(crossedBoundary).toMatchObject({
        outcome: 'CONTRACTUAL_DISCOUNT_CONFLICT',
        reason: 'BOUNDARY_CROSSED',
      });

      const counts = yield* admin.execute<{
        readonly generation: number;
        readonly receiptCount: number;
        readonly revisionCount: number;
      }>(
        sql`select
              (select generation from pricing.contractual_discount_set_heads where tenant_id = ${tenantId}::uuid) as generation,
              (select count(*)::integer from pricing.contractual_discount_action_invocation_receipts where tenant_id = ${tenantId}::uuid) as "receiptCount",
              (select count(*)::integer from pricing.contractual_discount_revisions where tenant_id = ${tenantId}::uuid) as "revisionCount"`,
        'objects',
      );
      expect(counts).toEqual([{ generation: 2, receiptCount: 5, revisionCount: 2 }]);
    }),
  ),
);

it.live('requires the exact future schedule acknowledgement and preserves immutable interval history', () =>
  Effect.scoped(
    Effect.gen(function* discountScheduleAcknowledgement() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const created = yield* withPersistence(runtime, (persistence) =>
        persistence.manage(createCommand('e7970000-0000-4000-8000-000000000020', '10')),
      );
      expect(created.outcome).toBe('CONTRACTUAL_DISCOUNT_CREATED');
      if (created.outcome !== 'CONTRACTUAL_DISCOUNT_CREATED' || created.schedule.current === undefined) {
        throw new Error('Expected the initial Current contractual Discount');
      }
      const initialRevision = created.schedule.current;
      const futureRevision = {
        definition: {
          discountId: created.schedule.discountId,
          identityKey,
          revision: {
            configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT' as const, level: { amount: '15', currencyCode: 'CZK' } },
            effectiveFrom: futurePeriod.effectiveFrom,
            revision: 2,
            revisionId: 'e7970000-0000-4000-8000-000000000021',
          },
        },
        effectivePeriod: futurePeriod,
        lineage: {
          correctedRevisionId: null,
          kind: 'SCHEDULED' as const,
          previousRevisionId: initialRevision.definition.revision.revisionId,
        },
      };
      const seededSchedule = {
        ...created.schedule,
        future: [futureRevision],
        revisions: [initialRevision, futureRevision],
        scheduleRevision: 2,
      };
      const encodedSeededSchedule = yield* encodeJson(seededSchedule);
      yield* admin.transaction((transaction) =>
        Effect.gen(function* seedFutureSchedule() {
          const rows = yield* transaction.execute<{ readonly contractualDiscountRevisionId: string }>(
            sql`insert into pricing.contractual_discount_revisions (
                  tenant_id, legal_entity_id, discount_id, schedule_revision,
                  previous_contractual_discount_revision_id, schedule, action_invocation_id,
                  command_fingerprint, acting_principal_id, reason
                ) select
                  ${tenantId}::uuid, ${legalEntityId}::uuid, ${created.schedule.discountId}::uuid, 2,
                  contractual_discount_revision_id, ${encodedSeededSchedule}::jsonb,
                  'e7970000-0000-4000-8000-000000000022'::uuid,
                  ${'a'.repeat(64)}, ${principalId}::uuid, 'Seed an immutable future schedule fixture'
                from pricing.contractual_discount_schedule_heads
                where tenant_id = ${tenantId}::uuid and discount_id = ${created.schedule.discountId}::uuid
                returning contractual_discount_revision_id as "contractualDiscountRevisionId"`,
            'objects',
          );
          const [row] = rows;
          if (row === undefined) {
            throw new Error('Expected seeded schedule revision');
          }
          yield* transaction.execute(sql`update pricing.contractual_discount_schedule_heads
            set contractual_discount_revision_id = ${row.contractualDiscountRevisionId}::uuid, schedule_revision = 2
            where tenant_id = ${tenantId}::uuid and discount_id = ${created.schedule.discountId}::uuid`);
        }),
      );

      const expectedCurrent = { ...expectedCurrentFrom(created.schedule), scheduleRevision: 2 };
      const editCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000023',
        configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT' as const, level: { amount: '12', currencyCode: 'CZK' } },
        expectedCurrent,
        identityKey,
        intent: 'VALUE_ONLY_CURRENT' as const,
        reason: 'Change only the remaining Current interval',
        requestCorrelationId: 'contractual-discount-ack',
        trustedOperationAt: instant(editAt),
      };
      const challenge = yield* withPersistence(runtime, (persistence) => persistence.manage(editCommand));
      expect(challenge.outcome).toBe('CONTRACTUAL_DISCOUNT_ACKNOWLEDGEMENT_REQUIRED');
      if (challenge.outcome !== 'CONTRACTUAL_DISCOUNT_ACKNOWLEDGEMENT_REQUIRED') {
        throw new Error('Expected a future-schedule acknowledgement challenge');
      }
      expect(challenge.acknowledgement.presentedFuture).toEqual([futureRevision]);
      expect(challenge.acknowledgement.intendedEffectivePeriod).toEqual({
        effectiveFrom: editAt,
        effectiveTo: currentPeriod.effectiveTo,
      });

      const revised = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          ...editCommand,
          acknowledgement: challenge.acknowledgement,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000024',
          trustedOperationAt: instant('2026-09-27T10:35:00.000Z'),
        }),
      );
      expect(revised.outcome).toBe('CONTRACTUAL_DISCOUNT_REVISED');
      if (revised.outcome !== 'CONTRACTUAL_DISCOUNT_REVISED') {
        throw new Error('Expected an acknowledged Current value change');
      }
      expect(revised.schedule.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: currentPeriod.effectiveFrom, effectiveTo: editAt },
        { effectiveFrom: editAt, effectiveTo: currentPeriod.effectiveTo },
        futurePeriod,
      ]);
      expect(revised.schedule.future).toEqual([futureRevision]);
      expect(revised.schedule.current?.definition.revision.configuredEffect).toEqual({
        kind: 'FIXED_MONETARY_AMOUNT',
        level: { amount: '12', currencyCode: 'CZK' },
      });
      const immutablePrior = yield* admin.execute<{ readonly schedule: unknown }>(
        sql`select schedule from pricing.contractual_discount_revisions
            where tenant_id = ${tenantId}::uuid and discount_id = ${created.schedule.discountId}::uuid
              and schedule_revision = 2`,
        'objects',
      );
      expect(immutablePrior[0]?.schedule).toEqual(seededSchedule);
      const staleSameValue = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          ...editCommand,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000025',
          configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '12', currencyCode: 'CZK' } },
        }),
      );
      expect(staleSameValue).toMatchObject({
        outcome: 'CONTRACTUAL_DISCOUNT_CONFLICT',
        reason: 'EXPECTED_CURRENT_STALE',
      });

      const revisedExpectedCurrent = expectedCurrentFrom(revised.schedule);
      const sameValueCommand = {
        ...editCommand,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000030',
        expectedCurrent: revisedExpectedCurrent,
      };
      const sameValueChallenge = yield* withPersistence(runtime, (persistence) => persistence.manage(sameValueCommand));
      expect(sameValueChallenge.outcome).toBe('CONTRACTUAL_DISCOUNT_ACKNOWLEDGEMENT_REQUIRED');
      if (sameValueChallenge.outcome !== 'CONTRACTUAL_DISCOUNT_ACKNOWLEDGEMENT_REQUIRED') {
        throw new Error('Expected schedule acknowledgement before a same-value no-op');
      }
      const unchanged = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          ...sameValueCommand,
          acknowledgement: sameValueChallenge.acknowledgement,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000031',
        }),
      );
      expect(unchanged).toMatchObject({ outcome: 'CONTRACTUAL_DISCOUNT_UNCHANGED' });
      const staleAcknowledgement = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          ...editCommand,
          acknowledgement: challenge.acknowledgement,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000026',
          configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '13', currencyCode: 'CZK' } },
          expectedCurrent: revisedExpectedCurrent,
        }),
      );
      expect(staleAcknowledgement).toMatchObject({
        outcome: 'CONTRACTUAL_DISCOUNT_CONFLICT',
        reason: 'ACKNOWLEDGEMENT_STALE',
      });
      const generationBeforeRetirement = yield* admin.execute<{ readonly generation: number }>(
        sql`select generation from pricing.contractual_discount_set_heads where tenant_id = ${tenantId}::uuid`,
        'objects',
      );
      expect(generationBeforeRetirement[0]?.generation).toBe(2);

      const retirementCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000027',
        expectedCurrent: revisedExpectedCurrent,
        identityKey,
        intent: 'RETIRE_CURRENT' as const,
        reason: 'End the remaining Current interval without filling the gap',
        requestCorrelationId: 'contractual-discount-retire',
        trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
      };
      const retirementChallenge = yield* withPersistence(runtime, (persistence) =>
        persistence.manage(retirementCommand),
      );
      expect(retirementChallenge.outcome).toBe('CONTRACTUAL_DISCOUNT_ACKNOWLEDGEMENT_REQUIRED');
      if (retirementChallenge.outcome !== 'CONTRACTUAL_DISCOUNT_ACKNOWLEDGEMENT_REQUIRED') {
        throw new Error('Expected a retirement schedule acknowledgement challenge');
      }
      const retired = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          ...retirementCommand,
          acknowledgement: retirementChallenge.acknowledgement,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000028',
          trustedOperationAt: instant('2026-09-27T11:05:00.000Z'),
        }),
      );
      expect(retired.outcome).toBe('CONTRACTUAL_DISCOUNT_RETIRED');
      if (retired.outcome !== 'CONTRACTUAL_DISCOUNT_RETIRED') {
        throw new Error('Expected an acknowledged Current retirement');
      }
      expect(retired.schedule.current).toBeUndefined();
      expect(retired.schedule.future).toEqual([futureRevision]);
      expect(retired.schedule.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: currentPeriod.effectiveFrom, effectiveTo: editAt },
        { effectiveFrom: editAt, effectiveTo: '2026-09-27T11:00:00.000Z' },
        futurePeriod,
      ]);
      const immutablePreRetirement = yield* admin.execute<{ readonly schedule: unknown }>(
        sql`select schedule from pricing.contractual_discount_revisions
            where tenant_id = ${tenantId}::uuid and discount_id = ${created.schedule.discountId}::uuid
              and schedule_revision = 3`,
        'objects',
      );
      expect(immutablePreRetirement[0]?.schedule).toEqual(revised.schedule);

      const [priorCurrent] = retired.schedule.revisions;
      if (priorCurrent === undefined) {
        throw new Error('Expected the preserved prior Current interval');
      }
      const corrected = yield* withPersistence(runtime, (persistence) =>
        persistence.manage({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000029',
          configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '11', currencyCode: 'CZK' } },
          expectedScheduleRevision: retired.schedule.scheduleRevision,
          identityKey,
          intent: 'CORRECT_REVISION',
          reason: 'Correct one immutable historical Discount interval',
          requestCorrelationId: 'contractual-discount-correction',
          targetEffectivePeriod: priorCurrent.effectivePeriod,
          targetRevisionId: priorCurrent.definition.revision.revisionId,
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      expect(corrected.outcome).toBe('CONTRACTUAL_DISCOUNT_CORRECTED');
      if (corrected.outcome !== 'CONTRACTUAL_DISCOUNT_CORRECTED') {
        throw new Error('Expected a historical Discount correction');
      }
      expect(corrected.schedule.current).toBeUndefined();
      expect(corrected.schedule.future).toEqual([futureRevision]);
      expect(corrected.schedule.revisions[0]?.lineage).toMatchObject({
        correctedRevisionId: priorCurrent.definition.revision.revisionId,
        kind: 'CORRECTION',
      });
      const finalGeneration = yield* admin.execute<{ readonly generation: number }>(
        sql`select generation from pricing.contractual_discount_set_heads where tenant_id = ${tenantId}::uuid`,
        'objects',
      );
      expect(finalGeneration[0]?.generation).toBe(4);
    }),
  ),
);
