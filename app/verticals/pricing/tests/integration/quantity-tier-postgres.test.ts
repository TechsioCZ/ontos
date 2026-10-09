import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { CatalogSelection } from '@app/catalog/domain/catalog-selection-evidence';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { QuantityTierIdentityKeySchema } from '@app/pricing-contracts/domain/quantity-tier';
import type { ExpectedQuantityTierCurrent, QuantityTierIdentityKey } from '@app/pricing-contracts/domain/quantity-tier';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type {
  QuantityTierPersistence,
  QuantityTierSetProofPersistence,
} from '../../src/services/quantity-tier-persistence.service.ts';
import { quantityTierPersistenceForScope } from '../../src/services/quantity-tier-persistence.service.ts';

const tenantId = 'e7660000-0000-4000-8000-000000000001';
const legalEntityId = 'e7660000-0000-4000-8000-000000000002';
const otherLegalEntityId = 'e7660000-0000-4000-8000-000000000003';
const principalId = 'e7660000-0000-4000-8000-000000000004';
const priceId = 'e7660000-0000-4000-8000-000000000005';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];

const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'e7660000-0000-4000-8000-000000000006',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const targetRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'e7660000-0000-4000-8000-000000000007',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const packageOptionRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'e7660000-0000-4000-8000-000000000018',
  resourceType: 'commerce.catalog.package-definition' as const,
  tenantId,
};
const catalogSelection: CatalogSelection = Schema.decodeSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: 'e7660000-0000-4000-8000-000000000016',
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: targetRef,
});
const packageCatalogSelection: CatalogSelection = Schema.decodeSync(CatalogSelectionSchema)({
  ...catalogSelection,
  packageOption: {
    contentRevision: { resourceRef: packageOptionRef, revision: 5 },
    optionRef: packageOptionRef,
  },
});
const identityKey: QuantityTierIdentityKey = Schema.decodeSync(QuantityTierIdentityKeySchema)({
  priceRef: {
    moduleId: 'commerce.pricing',
    resourceId: priceId,
    resourceType: 'commerce.pricing.price',
    tenantId,
  },
  quantityBasis: {
    catalogQuantityBasis: {
      targetDivisibilityRevision: 7,
      targetRef,
      unitRef,
      unitRuleRevision: 11,
    },
    priceUnitBasis: { quantity: '1', unitRef },
  },
  thresholdQuantity: '10',
});
const packageCompatibleIdentity: QuantityTierIdentityKey = {
  ...identityKey,
  quantityBasis: {
    ...identityKey.quantityBasis,
    catalogQuantityBasis: {
      ...identityKey.quantityBasis.catalogQuantityBasis,
      targetRef: packageOptionRef,
    },
  },
};
const scopeFor = (selectedLegalEntityId: string): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'e7660000-0000-4000-8000-000000000008',
    authContextRef: 'session:quantity-tier-postgres',
    authMethod: 'session',
    legalEntityId: selectedLegalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'quantity-tier-postgres',
});

const withPersistence = <Value, Failure>(
  database: PricingTestDatabase,
  selectedLegalEntityId: string,
  operation: (persistence: QuantityTierPersistence & QuantityTierSetProofPersistence) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* scopedQuantityTierPersistence() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${selectedLegalEntityId}, true)`,
        'objects',
      );
      const scope = scopeFor(selectedLegalEntityId);
      const ownerTransaction = yield* installOperationalScope(transaction, scope);
      const persistence = yield* quantityTierPersistenceForScope(ownerTransaction, scope);
      return yield* operation(persistence);
    }),
  );

const cleanup = (admin: PricingTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupQuantityTiers() {
      yield* transaction.execute(
        sql`delete from pricing.material_evidence_proof_receipts
            where tenant_id = ${tenantId}::uuid and family = 'QUANTITY_TIER'`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_schedule_acknowledgements where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_action_result_receipts where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_schedule_heads where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_schedule_entries where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_schedule_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.quantity_tier_revisions where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.quantity_tiers where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.quantity_tier_set_heads where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(
        sql`delete from pricing.quantity_tier_set_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.quantity_tier_set_roots where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(
        sql`delete from pricing.price_candidate_set_heads where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.price_candidate_set_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.price_candidate_set_roots where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.prices where tenant_id = ${tenantId}::uuid`);
    }),
  );

const seedPrice = (admin: PricingTestDatabase, selection: CatalogSelection = catalogSelection) =>
  admin.transaction((transaction) =>
    transaction.execute(sql`
      insert into pricing.prices (
        price_id, tenant_id, legal_entity_id, catalog_selection, channel_id, market_id,
        currency_code, unit_ref, basis_quantity, price_group_selector,
        created_by_action_invocation_id, created_by_principal_id
      ) values (
        ${priceId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid,
        ${JSON.stringify(selection)}::jsonb,
        'B2C', 'cz-launch', 'CZK', ${JSON.stringify(unitRef)}::jsonb, 1,
        '{"kind":"NO_GROUP"}'::jsonb,
        'e7660000-0000-4000-8000-000000000009'::uuid, ${principalId}::uuid
      )
    `),
  );

it.live('preserves a finite Current interval, its gap, and exact future schedule behind acknowledgement', () =>
  Effect.scoped(
    Effect.gen(function* quantityTierScheduleProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
      yield* seedPrice(admin);

      const created = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.define({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7660000-0000-4000-8000-000000000010',
          effectivePeriod: {
            effectiveFrom: '2026-09-27T10:00:00.000Z',
            effectiveTo: '2026-09-27T12:00:00.000Z',
          },
          expectedState: { state: 'ABSENT' },
          identityKey,
          reason: 'Define a zero-valid Quantity Tier.',
          requestCorrelationId: 'quantity-tier:define',
          resultingUnitPrice: { amount: '0', currencyCode: 'CZK' },
          trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
        }),
      );
      expect(created).toMatchObject({
        definition: { revision: { resultingUnitPrice: { amount: '0.000000000', currencyCode: 'CZK' } } },
        outcome: 'QUANTITY_TIER_CREATED',
      });

      const scheduled = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7660000-0000-4000-8000-000000000011',
          effectivePeriod: {
            effectiveFrom: '2026-09-27T14:00:00.000Z',
            effectiveTo: '2026-09-27T16:00:00.000Z',
          },
          expectedScheduleRevision: 1,
          identityKey,
          intent: 'SCHEDULE_REVISION',
          reason: 'Schedule a future Tier value without filling the gap.',
          requestCorrelationId: 'quantity-tier:schedule',
          resultingUnitPrice: { amount: '8', currencyCode: 'CZK' },
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      expect(scheduled.outcome).toBe('QUANTITY_TIER_REVISED');
      if (scheduled.outcome !== 'QUANTITY_TIER_REVISED') {
        throw new Error('Expected a scheduled Quantity Tier revision');
      }
      const { current } = scheduled.schedule;
      if (current === undefined) {
        throw new Error('Expected the initial Current Quantity Tier revision');
      }
      const expectedCurrent: ExpectedQuantityTierCurrent = {
        effectivePeriod: current.effectivePeriod,
        identityKey: current.definition.identityKey,
        revision: current.definition.revision.revision,
        revisionId: current.definition.revision.revisionId,
        scheduleRevision: scheduled.schedule.scheduleRevision,
      };

      const challenge = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7660000-0000-4000-8000-000000000012',
          effectiveFrom: '2026-09-27T11:00:00.000Z',
          expectedCurrent,
          identityKey,
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Revise only the Current Tier value.',
          requestCorrelationId: 'quantity-tier:challenge',
          resultingUnitPrice: { amount: '5', currencyCode: 'CZK' },
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      expect(challenge.outcome).toBe('QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED');
      if (challenge.outcome !== 'QUANTITY_TIER_ACKNOWLEDGEMENT_REQUIRED') {
        throw new Error('Expected an exact future-schedule acknowledgement challenge');
      }
      expect(challenge.acknowledgement.targetEffectivePeriod).toEqual(current.effectivePeriod);
      expect(challenge.acknowledgement.presentedFuture).toEqual(scheduled.schedule.future);

      const revised = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          acknowledgement: challenge.acknowledgement,
          actingPrincipalId: principalId,
          actionInvocationId: 'e7660000-0000-4000-8000-000000000014',
          effectiveFrom: '2026-09-27T11:00:00.000Z',
          expectedCurrent,
          identityKey,
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Revise only the Current Tier value.',
          requestCorrelationId: 'quantity-tier:challenge',
          resultingUnitPrice: { amount: '5', currencyCode: 'CZK' },
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      expect(revised.outcome).toBe('QUANTITY_TIER_REVISED');
      if (revised.outcome !== 'QUANTITY_TIER_REVISED') {
        throw new Error('Expected the acknowledged Current value edit');
      }
      expect(revised.schedule.current?.effectivePeriod).toEqual({
        effectiveFrom: '2026-09-27T11:00:00.000Z',
        effectiveTo: current.effectivePeriod.effectiveTo,
      });
      expect(revised.schedule.current?.definition.revision.resultingUnitPrice.amount).toBe('5.000000000');
      expect(revised.schedule.future).toEqual(scheduled.schedule.future);
      expect(revised.schedule.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: '2026-09-27T11:00:00.000Z' },
        { effectiveFrom: '2026-09-27T11:00:00.000Z', effectiveTo: '2026-09-27T12:00:00.000Z' },
        { effectiveFrom: '2026-09-27T14:00:00.000Z', effectiveTo: '2026-09-27T16:00:00.000Z' },
      ]);

      const staleAcknowledgement = yield* withPersistence(runtime, legalEntityId, (persistence) => {
        const revisedCurrent = revised.schedule.current;
        if (revisedCurrent === undefined) {
          return Effect.die('Expected revised Current Quantity Tier');
        }
        return persistence.revise({
          acknowledgement: challenge.acknowledgement,
          actingPrincipalId: principalId,
          actionInvocationId: 'e7660000-0000-4000-8000-000000000013',
          effectiveFrom: '2026-09-27T11:00:00.000Z',
          expectedCurrent: {
            effectivePeriod: revisedCurrent.effectivePeriod,
            identityKey: revisedCurrent.definition.identityKey,
            revision: revisedCurrent.definition.revision.revision,
            revisionId: revisedCurrent.definition.revision.revisionId,
            scheduleRevision: revised.schedule.scheduleRevision,
          },
          identityKey,
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Reject stale acknowledgement evidence.',
          requestCorrelationId: 'quantity-tier:stale-ack',
          resultingUnitPrice: { amount: '4', currencyCode: 'CZK' },
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        });
      });
      expect(staleAcknowledgement).toMatchObject({
        outcome: 'QUANTITY_TIER_CONFLICT',
        reason: 'ACKNOWLEDGEMENT_STALE',
      });
    }),
  ),
);

it.live('rejects Price target/currency/basis mismatch and isolates Tier identity by SLE', () =>
  Effect.scoped(
    Effect.gen(function* quantityTierOwnershipProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
      yield* seedPrice(admin, packageCatalogSelection);

      const define = (candidateIdentity: QuantityTierIdentityKey, currencyCode: string, invocation: string) =>
        withPersistence(runtime, legalEntityId, (persistence) =>
          persistence.define({
            actingPrincipalId: principalId,
            actionInvocationId: invocation,
            effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
            expectedState: { state: 'ABSENT' },
            identityKey: candidateIdentity,
            reason: 'Prove exact owning Price compatibility.',
            requestCorrelationId: invocation,
            resultingUnitPrice: { amount: '10', currencyCode },
            trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
          }),
        );
      const targetMismatch = yield* define(identityKey, 'CZK', 'e7660000-0000-4000-8000-000000000019');
      expect(targetMismatch).toMatchObject({ outcome: 'QUANTITY_TIER_CONFLICT', reason: 'IDENTITY_MISMATCH' });
      const currencyMismatch = yield* define(packageCompatibleIdentity, 'EUR', 'e7660000-0000-4000-8000-000000000020');
      expect(currencyMismatch).toMatchObject({ outcome: 'QUANTITY_TIER_CONFLICT', reason: 'IDENTITY_MISMATCH' });
      const basisMismatch = yield* define(
        {
          ...packageCompatibleIdentity,
          quantityBasis: {
            ...packageCompatibleIdentity.quantityBasis,
            priceUnitBasis: { ...packageCompatibleIdentity.quantityBasis.priceUnitBasis, quantity: '2' },
          },
        },
        'CZK',
        'e7660000-0000-4000-8000-000000000021',
      );
      expect(basisMismatch).toMatchObject({ outcome: 'QUANTITY_TIER_CONFLICT', reason: 'IDENTITY_MISMATCH' });

      const counts = yield* admin.execute<{ readonly revisionCount: number; readonly tierCount: number }>(
        sql`select
              (select count(*)::integer from pricing.quantity_tiers where tenant_id = ${tenantId}::uuid)
                as "tierCount",
              (select count(*)::integer from pricing.quantity_tier_revisions where tenant_id = ${tenantId}::uuid)
                as "revisionCount"`,
        'objects',
      );
      expect(counts).toEqual([{ revisionCount: 0, tierCount: 0 }]);

      const packageTarget = yield* define(packageCompatibleIdentity, 'CZK', 'e7660000-0000-4000-8000-000000000022');
      expect(packageTarget.outcome).toBe('QUANTITY_TIER_CREATED');

      const crossSle = yield* withPersistence(runtime, otherLegalEntityId, (persistence) =>
        persistence.readCurrent({ effectiveAt: '2026-09-27T11:00:00.000Z', identityKey: packageCompatibleIdentity }),
      );
      expect(crossSle).toMatchObject({ outcome: 'QUANTITY_TIER_ABSENT' });
    }),
  ),
);

it.live('proves the complete Current set with one monotonic price-scoped generation', () =>
  Effect.scoped(
    Effect.gen(function* quantityTierSetAuthorityProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
      yield* seedPrice(admin);

      const { priceRef } = identityKey;
      const empty = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrentSet({ effectiveAt: '2026-09-27T11:00:00.000Z', priceRef }),
      );
      expect(empty).toMatchObject({
        authority: { generation: 1 },
        outcome: 'QUANTITY_TIER_SET_CURRENT',
        tierSet: { currentTiers: [], priceRef },
      });
      if (empty.outcome !== 'QUANTITY_TIER_SET_CURRENT') {
        throw new Error('Expected the Price-owned empty Tier set');
      }

      const defineTier = (candidateIdentity: QuantityTierIdentityKey, invocation: string, amount: string) =>
        withPersistence(runtime, legalEntityId, (persistence) =>
          persistence.define({
            actingPrincipalId: principalId,
            actionInvocationId: invocation,
            effectivePeriod: {
              effectiveFrom: '2026-09-27T10:00:00.000Z',
              effectiveTo: '2999-09-27T13:00:00.000Z',
            },
            expectedState: { state: 'ABSENT' },
            identityKey: candidateIdentity,
            reason: 'Advance the exact Price Tier-set generation.',
            requestCorrelationId: invocation,
            resultingUnitPrice: { amount, currencyCode: 'CZK' },
            trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
          }),
        );

      const firstInvocation = 'e7660000-0000-4000-8000-000000000030';
      const first = yield* defineTier(identityKey, firstInvocation, '9');
      expect(first.outcome).toBe('QUANTITY_TIER_CREATED');
      if (first.outcome !== 'QUANTITY_TIER_CREATED' && first.outcome !== 'QUANTITY_TIER_REUSED') {
        throw new Error('Expected the first Quantity Tier definition');
      }
      const firstSet = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrentSet({ effectiveAt: '2026-09-27T11:00:00.000Z', priceRef }),
      );
      expect(firstSet).toMatchObject({
        authority: { generation: 2, ownerRootRef: empty.authority.ownerRootRef },
        outcome: 'QUANTITY_TIER_SET_CURRENT',
        tierSet: { currentTiers: [{ definition: { identityKey: { thresholdQuantity: '10.000000000' } } }] },
      });
      if (firstSet.outcome !== 'QUANTITY_TIER_SET_CURRENT') {
        throw new Error('Expected the first Current Tier set');
      }

      const replay = yield* defineTier(identityKey, firstInvocation, '9');
      expect(replay.outcome).toBe('QUANTITY_TIER_CREATED');
      const afterReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrentSet({ effectiveAt: '2026-09-27T11:00:00.000Z', priceRef }),
      );
      expect(afterReplay).toMatchObject({
        authority: { generation: 2, ownerRevision: firstSet.authority.ownerRevision },
      });

      const secondIdentity: QuantityTierIdentityKey = { ...identityKey, thresholdQuantity: '20' };
      yield* defineTier(secondIdentity, 'e7660000-0000-4000-8000-000000000031', '8');
      const complete = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrentSet({ effectiveAt: '2026-09-27T11:00:00.000Z', priceRef }),
      );
      expect(complete).toMatchObject({ authority: { generation: 3 }, outcome: 'QUANTITY_TIER_SET_CURRENT' });
      if (complete.outcome !== 'QUANTITY_TIER_SET_CURRENT') {
        throw new Error('Expected the complete two-tier Current set');
      }
      expect(complete.tierSet.currentTiers.map(({ definition }) => definition.identityKey.thresholdQuantity)).toEqual([
        '10.000000000',
        '20.000000000',
      ]);

      const changed = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.verifySetGeneration({
          ...firstSet.authority,
          effectiveAt: '2026-09-27T11:00:00.000Z',
          priceRef,
          through: firstSet.authority.observedAt,
        }),
      );
      expect(changed.outcome).toBe('QUANTITY_TIER_SET_GENERATION_CHANGED');
      const current = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.verifySetGeneration({
          ...complete.authority,
          effectiveAt: '2026-09-27T11:00:00.000Z',
          priceRef,
          through: complete.authority.observedAt,
        }),
      );
      expect(current).toMatchObject({
        generation: 3,
        outcome: 'QUANTITY_TIER_SET_GENERATION_CURRENT',
        ownerRevision: complete.authority.ownerRevision,
        ownerRootRef: complete.authority.ownerRootRef,
        verificationRef: complete.authority.verificationRef,
      });
      const futureThrough = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.verifySetGeneration({
          ...complete.authority,
          effectiveAt: '2026-09-27T11:00:00.000Z',
          priceRef,
          through: '2999-09-27T11:00:00.000Z',
        }),
      );
      expect(futureThrough).toMatchObject({
        outcome: 'QUANTITY_TIER_SET_GENERATION_UNVERIFIABLE',
        reason: 'THROUGH_NOT_YET_OBSERVABLE',
      });
      expect(futureThrough).not.toHaveProperty('verifiedThrough');
      const wrongVerificationReference = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.verifySetGeneration({
          ...complete.authority,
          effectiveAt: '2026-09-27T11:00:00.000Z',
          priceRef,
          through: complete.authority.observedAt,
          verificationRef: 'commerce.pricing.quantity-tier-set-proof:wrong',
        }),
      );
      expect(wrongVerificationReference).toMatchObject({
        outcome: 'QUANTITY_TIER_SET_GENERATION_UNVERIFIABLE',
        reason: 'VERIFICATION_REFERENCE_MISMATCH',
      });

      const firstSchedule = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readSchedule({ identityKey, trustedOperationAt: instant('2026-09-27T11:00:00.000Z') }),
      );
      if (firstSchedule.outcome !== 'QUANTITY_TIER_SCHEDULE_CURRENT') {
        throw new Error('Expected the first Tier schedule');
      }
      yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7660000-0000-4000-8000-000000000032',
          effectivePeriod: { effectiveFrom: '2999-09-27T13:00:00.000Z', effectiveTo: null },
          expectedScheduleRevision: firstSchedule.schedule.scheduleRevision,
          identityKey,
          intent: 'SCHEDULE_REVISION',
          reason: 'Advance the set generation for an effectivity-relevant mutation.',
          requestCorrelationId: 'quantity-tier:set-authority:schedule',
          resultingUnitPrice: { amount: '7', currencyCode: 'CZK' },
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      const scheduled = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrentSet({ effectiveAt: '2026-09-27T11:00:00.000Z', priceRef }),
      );
      expect(scheduled).toMatchObject({
        authority: { generation: 4, ownerRootRef: complete.authority.ownerRootRef },
        outcome: 'QUANTITY_TIER_SET_CURRENT',
      });
      if (scheduled.outcome !== 'QUANTITY_TIER_SET_CURRENT') {
        throw new Error('Expected the scheduled Tier set');
      }
      expect(scheduled.tierSet.completenessEvidence.nextApplicabilityBoundary).toEqual(
        DateTime.makeUnsafe('2999-09-27T13:00:00.000Z'),
      );
      const boundaryCrossed = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.verifySetGeneration({
          ...scheduled.authority,
          effectiveAt: '2026-09-27T11:00:00.000Z',
          priceRef,
          through: '2999-09-27T13:00:00.000Z',
        }),
      );
      expect(boundaryCrossed).toMatchObject({
        outcome: 'QUANTITY_TIER_SET_GENERATION_UNVERIFIABLE',
        reason: 'THROUGH_NOT_YET_OBSERVABLE',
      });

      const originalFirstSet = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.resolveQuantityTierSetProof({
          effectiveAt: '2026-09-27T11:00:00.000Z',
          priceRef,
          verificationRef: firstSet.authority.verificationRef,
        }),
      );
      expect(originalFirstSet).toMatchObject({
        authority: firstSet.authority,
        outcome: 'QUANTITY_TIER_SET_PROOF_RESOLVED',
        tierSet: {
          currentTiers: [
            {
              definition: {
                identityKey: { thresholdQuantity: '10.000000000' },
                revision: { revisionId: first.definition.revision.revisionId },
              },
            },
          ],
        },
      });
      if (originalFirstSet.outcome !== 'QUANTITY_TIER_SET_PROOF_RESOLVED') {
        throw new Error('Expected the original one-tier proof to resolve');
      }
      expect(originalFirstSet.currentFacts).toEqual([
        {
          factRef: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          factRevisionRef: first.definition.revision.revisionId,
          verificationRef: firstSet.authority.verificationRef,
        },
      ]);
      expect(originalFirstSet.tierSet.currentTiers).toHaveLength(1);

      const missingOriginal = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.resolveQuantityTierSetProof({
          effectiveAt: '2026-09-27T11:00:00.000Z',
          priceRef,
          verificationRef:
            'commerce.pricing.quantity-tier-set-proof:e7660000-0000-4000-8000-000000000090:e7660000-0000-4000-8000-000000000091:2',
        }),
      );
      expect(missingOriginal).toMatchObject({
        outcome: 'QUANTITY_TIER_SET_PROOF_ABSENT',
        priceRef,
      });

      yield* admin.execute(
        sql`delete from pricing.quantity_tier_set_heads
             where tenant_id = ${tenantId}::uuid
               and legal_entity_id = ${legalEntityId}::uuid
               and price_id = ${priceId}::uuid`,
      );
      const authorityUnavailable = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrentSet({ effectiveAt: '2026-09-27T11:00:00.000Z', priceRef }),
      );
      expect(authorityUnavailable).toMatchObject({
        outcome: 'QUANTITY_TIER_SET_AUTHORITY_UNAVAILABLE',
        priceRef,
        retryable: true,
      });
      const absentPrice = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrentSet({
          effectiveAt: '2026-09-27T11:00:00.000Z',
          priceRef: { ...priceRef, resourceId: 'e7660000-0000-4000-8000-000000000099' },
        }),
      );
      expect(absentPrice).toMatchObject({ outcome: 'QUANTITY_TIER_SET_PRICE_ABSENT' });
    }),
  ),
);
