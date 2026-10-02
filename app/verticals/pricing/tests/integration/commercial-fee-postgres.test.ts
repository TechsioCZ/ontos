import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  PricingCommercialFeeCatalogTargetEvidenceSchema,
  PricingCommercialFeeIdentityKeySchema,
} from '@app/pricing-contracts/domain/commercial-fee';
import type {
  ExpectedPricingCommercialFeeCurrent,
  PricingCommercialFeeFamily,
  PricingCommercialFeeIdentityKey,
} from '@app/pricing-contracts/domain/commercial-fee';
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
  CommercialFeeActionResultLookupPersistence,
  CommercialFeePersistence,
  DefineCommercialFeePersistenceCommand,
} from '../../src/services/commercial-fee-persistence.service.ts';
import {
  DefineCommercialFeePersistenceOutcomeSchema,
  commercialFeePersistenceForScope,
} from '../../src/services/commercial-fee-persistence.service.ts';

const tenantId = 'e7730000-0000-4000-8000-000000000001';
const legalEntityId = 'e7730000-0000-4000-8000-000000000002';
const otherLegalEntityId = 'e7730000-0000-4000-8000-000000000003';
const otherTenantId = 'e7970000-0000-4000-8000-000000000099';
const principalId = 'e7730000-0000-4000-8000-000000000004';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];
type TestCommercialFeePersistence = CommercialFeePersistence & CommercialFeeActionResultLookupPersistence;

const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'e7730000-0000-4000-8000-000000000005',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const alternateProductRef = {
  ...productRef,
  resourceId: 'e7730000-0000-4000-8000-00000000000f',
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'e7730000-0000-4000-8000-000000000006',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'e7730000-0000-4000-8000-000000000007',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const identityFor = (
  family: PricingCommercialFeeFamily,
  calculationBasis?: PricingCommercialFeeIdentityKey['calculationBasis'],
): PricingCommercialFeeIdentityKey =>
  Schema.decodeSync(PricingCommercialFeeIdentityKeySchema)({
    calculationBasis: calculationBasis ?? { kind: 'FIXED_PER_LINE' },
    commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
    currencyCode: 'CZK',
    family,
    monetaryBoundary: 'PRE_TAX',
    target: { variantRef },
  });
const catalogTargetEvidenceFor = (selectedProductRef: typeof productRef = productRef) =>
  Schema.decodeSync(PricingCommercialFeeCatalogTargetEvidenceSchema)({
    capturedAt: '2026-09-27T08:00:00.000Z',
    catalogOwnerRevision: `catalog:products:${selectedProductRef.resourceId}:42`,
    productRef: selectedProductRef,
    snapshotId: `catalog:snapshot:${selectedProductRef.resourceId}:42`,
    targetId: `catalog:target:${variantRef.resourceId}`,
    variantRef,
  });

const scopeFor = (selectedLegalEntityId: string, selectedTenantId = tenantId): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'e7730000-0000-4000-8000-000000000008',
    authContextRef: 'session:commercial-fee-postgres',
    authMethod: 'session',
    legalEntityId: selectedLegalEntityId,
    principalId,
    tenantId: selectedTenantId,
  }),
  correlationId: 'commercial-fee-postgres',
});

const withPersistence = <Value, Failure>(
  database: PricingTestDatabase,
  selectedLegalEntityId: string,
  operation: (persistence: TestCommercialFeePersistence) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* scopedCommercialFeePersistence() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${selectedLegalEntityId}, true)`,
        'objects',
      );
      const scope = scopeFor(selectedLegalEntityId);
      const ownerTransaction = yield* installOperationalScope(transaction, scope);
      const persistence = yield* commercialFeePersistenceForScope(ownerTransaction, scope);
      return yield* operation(persistence);
    }),
  );

const withTenantPersistence = <Value, Failure>(
  database: PricingTestDatabase,
  selectedTenantId: string,
  selectedLegalEntityId: string,
  operation: (persistence: TestCommercialFeePersistence) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* scopedTenantCommercialFeePersistence() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${selectedTenantId}, true),
                   set_config('ontos.legal_entity_id', ${selectedLegalEntityId}, true)`,
        'objects',
      );
      const scope = scopeFor(selectedLegalEntityId, selectedTenantId);
      const ownerTransaction = yield* installOperationalScope(transaction, scope);
      const persistence = yield* commercialFeePersistenceForScope(ownerTransaction, scope);
      return yield* operation(persistence);
    }),
  );

const defineCommercialFeeThroughDeployedV1 = (
  database: PricingTestDatabase,
  definition: DefineCommercialFeePersistenceCommand,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* executeDeployedCommercialFeeWriter() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
        'objects',
      );
      const encodedDefinition = yield* encodeJson(definition);
      const rows = yield* transaction.execute<{ readonly payload: unknown }>(
        sql`select result.payload
              from pricing.define_commercial_fee_v1(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${encodedDefinition}::jsonb
              ) as result`,
        'objects',
      );
      const [row] = rows;
      return yield* Schema.decodeUnknownEffect(DefineCommercialFeePersistenceOutcomeSchema)(row?.payload);
    }),
  );

const cleanup = (admin: PricingTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupCommercialFees() {
      yield* transaction.execute(
        sql`delete from pricing.price_fee_action_result_receipts where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.price_fee_action_invocation_claims where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.fee_action_invocation_receipts where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.fee_schedule_acknowledgements where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.fee_schedule_heads where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.fee_schedule_entries where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.fee_schedule_revisions where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.fee_revisions where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.fee_set_heads where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.fee_set_revisions where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.fee_set_roots where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.fees where tenant_id = ${tenantId}::uuid`);
    }),
  );

it.live('persists exact-key Fees without choosing competing truth and permits different families', () =>
  Effect.scoped(
    Effect.gen(function* commercialFeeIdentityProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const define = (family: PricingCommercialFeeFamily, amount: string, invocation: string) =>
        withPersistence(runtime, legalEntityId, (persistence) =>
          persistence.define({
            actingPrincipalId: principalId,
            actionInvocationId: invocation,
            catalogTargetEvidence: catalogTargetEvidenceFor(),
            configuredAmount: { amount, currencyCode: 'CZK' },
            effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
            identityKey: identityFor(family),
            reason: 'Define an exact Variant Commercial Fee.',
            requestCorrelationId: invocation,
            trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
          }),
        );

      const currencyMismatch = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.define({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7730000-0000-4000-8000-000000000009',
          catalogTargetEvidence: catalogTargetEvidenceFor(),
          configuredAmount: { amount: '20', currencyCode: 'EUR' },
          effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
          identityKey: identityFor('RECYCLING_FEE'),
          reason: 'Reject a mismatched configured currency.',
          requestCorrelationId: 'commercial-fee:currency-mismatch',
          trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
        }),
      );
      expect(currencyMismatch).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });

      const deployedRecyclingInvocationId = 'e7730000-0000-4000-8000-000000000010';
      const deployedRecyclingCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: deployedRecyclingInvocationId,
        catalogTargetEvidence: catalogTargetEvidenceFor(),
        configuredAmount: { amount: '20', currencyCode: 'CZK' },
        effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
        identityKey: identityFor('RECYCLING_FEE'),
        reason: 'Define an exact Variant Commercial Fee through the deployed v1 signature.',
        requestCorrelationId: deployedRecyclingInvocationId,
        trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
      } satisfies DefineCommercialFeePersistenceCommand;
      const recycling = yield* defineCommercialFeeThroughDeployedV1(runtime, deployedRecyclingCommand);
      expect(recycling.outcome).toBe('COMMERCIAL_FEE_CREATED');
      expect(
        yield* withPersistence(runtime, legalEntityId, (persistence) =>
          persistence.lookupResult({ actionInvocationId: deployedRecyclingInvocationId }),
        ),
      ).toEqual({
        actionInvocationId: deployedRecyclingInvocationId,
        outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND',
        result: recycling,
      });
      const copyright = yield* define('COPYRIGHT_FEE', '5', 'e7730000-0000-4000-8000-000000000011');
      expect(copyright.outcome).toBe('COMMERCIAL_FEE_CREATED');

      const competing = yield* define('RECYCLING_FEE', '21', 'e7730000-0000-4000-8000-000000000012');
      expect(competing).toMatchObject({ outcome: 'COMMERCIAL_FEE_CONFLICT', reason: 'IDENTITY_MISMATCH' });

      const changedProductSnapshot = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.define({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7730000-0000-4000-8000-000000000013',
          catalogTargetEvidence: catalogTargetEvidenceFor(alternateProductRef),
          configuredAmount: { amount: '20', currencyCode: 'CZK' },
          effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
          identityKey: identityFor('RECYCLING_FEE'),
          reason: 'Do not split one exact Variant Fee by Product snapshot evidence.',
          requestCorrelationId: 'commercial-fee:changed-product-snapshot',
          trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
        }),
      );
      expect(changedProductSnapshot).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });

      const current = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrent({
          effectiveAt: '2026-09-27T11:00:00.000Z',
          identityKey: identityFor('RECYCLING_FEE'),
        }),
      );
      expect(current).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CURRENT',
        revision: { definition: { revision: { configuredAmount: { amount: '20.000000000' } } } },
      });
      if (current.outcome !== 'COMMERCIAL_FEE_CURRENT') {
        throw new Error('Expected a Current Recycling Fee');
      }
      const recyclingExpected: ExpectedPricingCommercialFeeCurrent = {
        effectivePeriod: current.revision.effectivePeriod,
        feeRef: current.revision.definition.feeRef,
        identityKey: identityFor('RECYCLING_FEE'),
        revision: current.revision.definition.revision.revision,
        revisionId: current.revision.definition.revision.revisionId,
        scheduleRevision: 1,
      };
      const copyrightCurrent = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrent({
          effectiveAt: '2026-09-27T11:00:00.000Z',
          identityKey: identityFor('COPYRIGHT_FEE'),
        }),
      );
      if (copyrightCurrent.outcome !== 'COMMERCIAL_FEE_CURRENT') {
        throw new Error('Expected a Current Copyright Fee');
      }
      const copyrightExpected: ExpectedPricingCommercialFeeCurrent = {
        effectivePeriod: copyrightCurrent.revision.effectivePeriod,
        feeRef: copyrightCurrent.revision.definition.feeRef,
        identityKey: identityFor('COPYRIGHT_FEE'),
        revision: copyrightCurrent.revision.definition.revision.revision,
        revisionId: copyrightCurrent.revision.definition.revision.revisionId,
        scheduleRevision: 1,
      };
      const replayInvocationId = 'e7730000-0000-4000-8000-000000000014';
      const reviseRecycling = {
        actingPrincipalId: principalId,
        actionInvocationId: replayInvocationId,
        catalogTargetEvidence: catalogTargetEvidenceFor(alternateProductRef),
        configuredAmount: { amount: '22', currencyCode: 'CZK' },
        effectiveFrom: '2026-09-27T11:00:00.000Z',
        expectedCurrent: recyclingExpected,
        identityKey: identityFor('RECYCLING_FEE'),
        intent: 'VALUE_ONLY_CURRENT' as const,
        reason: 'Revise the Recycling Fee exactly once.',
        requestCorrelationId: 'commercial-fee:exact-replay',
        trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
      };
      const revised = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise(reviseRecycling),
      );
      expect(revised.outcome).toBe('COMMERCIAL_FEE_REVISED');
      if (revised.outcome !== 'COMMERCIAL_FEE_REVISED') {
        throw new Error('Expected a revised Recycling Fee');
      }
      expect(revised.schedule.current?.definition.catalogTargetEvidence.productRef).toEqual(alternateProductRef);
      const exactReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise(reviseRecycling),
      );
      expect(exactReplay).toEqual(revised);
      expect(
        yield* withPersistence(runtime, legalEntityId, (persistence) =>
          persistence.revise({
            ...reviseRecycling,
            requestCorrelationId: 'commercial-fee:lost-response-retry',
          }),
        ),
      ).toEqual(revised);
      expect(
        yield* withPersistence(runtime, legalEntityId, (persistence) =>
          persistence.lookupResult({ actionInvocationId: replayInvocationId }),
        ),
      ).toEqual({
        actionInvocationId: replayInvocationId,
        outcome: 'COMMERCIAL_FEE_ACTION_RESULT_FOUND',
        result: revised,
      });
      expect(
        yield* withPersistence(runtime, legalEntityId, (persistence) =>
          persistence.lookupResult({ actionInvocationId: 'e773ffff-0000-4000-8000-000000000001' }),
        ),
      ).toEqual({
        actionInvocationId: 'e773ffff-0000-4000-8000-000000000001',
        outcome: 'COMMERCIAL_FEE_ACTION_RESULT_ABSENT',
      });
      const crossLegalEntityIdentity = {
        ...identityFor('RECYCLING_FEE'),
        commercialScope: {
          ...identityFor('RECYCLING_FEE').commercialScope,
          sellingLegalEntityId: otherLegalEntityId,
        },
      };
      expect(
        yield* withPersistence(runtime, otherLegalEntityId, (persistence) =>
          persistence.define({
            actingPrincipalId: principalId,
            actionInvocationId: replayInvocationId,
            catalogTargetEvidence: catalogTargetEvidenceFor(),
            configuredAmount: { amount: '22', currencyCode: 'CZK' },
            effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
            identityKey: crossLegalEntityIdentity,
            reason: 'Reject Tenant-wide invocation reuse in another Legal Entity.',
            requestCorrelationId: 'commercial-fee:cross-legal-entity-reuse',
            trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
          }),
        ),
      ).toMatchObject({ outcome: 'COMMERCIAL_FEE_CONFLICT', reason: 'IDENTITY_MISMATCH' });
      const changedReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...reviseRecycling,
          configuredAmount: { amount: '23', currencyCode: 'CZK' },
        }),
      );
      expect(changedReplay).toMatchObject({ outcome: 'COMMERCIAL_FEE_CONFLICT', reason: 'IDENTITY_MISMATCH' });
      const crossFeeReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...reviseRecycling,
          configuredAmount: { amount: '6', currencyCode: 'CZK' },
          expectedCurrent: copyrightExpected,
          identityKey: identityFor('COPYRIGHT_FEE'),
        }),
      );
      expect(crossFeeReplay).toMatchObject({ outcome: 'COMMERCIAL_FEE_CONFLICT', reason: 'IDENTITY_MISMATCH' });

      const revisedCurrent = revised.schedule.current;
      if (revisedCurrent === undefined) {
        throw new Error('Expected the revised Recycling Fee to remain Current');
      }
      const noOpExpected: ExpectedPricingCommercialFeeCurrent = {
        effectivePeriod: revisedCurrent.effectivePeriod,
        feeRef: revisedCurrent.definition.feeRef,
        identityKey: identityFor('RECYCLING_FEE'),
        revision: revisedCurrent.definition.revision.revision,
        revisionId: revisedCurrent.definition.revision.revisionId,
        scheduleRevision: revised.schedule.scheduleRevision,
      };
      const noOpInvocationId = 'e7730000-0000-4000-8000-000000000015';
      const noOpCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: noOpInvocationId,
        catalogTargetEvidence: catalogTargetEvidenceFor(alternateProductRef),
        configuredAmount: { amount: '22', currencyCode: 'CZK' },
        effectiveFrom: revisedCurrent.effectivePeriod.effectiveFrom,
        expectedCurrent: noOpExpected,
        identityKey: identityFor('RECYCLING_FEE'),
        intent: 'VALUE_ONLY_CURRENT' as const,
        reason: 'Confirm an exact no-op Fee revision.',
        requestCorrelationId: 'commercial-fee:no-op-replay',
        trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
      };
      const noOpCountsBefore = yield* admin.execute<{
        readonly feeCount: number;
        readonly headCount: number;
        readonly receiptCount: number;
        readonly revisionCount: number;
        readonly scheduleRevisionCount: number;
      }>(
        sql`select
              (select count(*)::integer from pricing.fees
                where tenant_id = ${tenantId}::uuid) as "feeCount",
              (select count(*)::integer from pricing.fee_schedule_heads
                where tenant_id = ${tenantId}::uuid) as "headCount",
              (select count(*)::integer from pricing.fee_action_invocation_receipts
                where tenant_id = ${tenantId}::uuid) as "receiptCount",
              (select count(*)::integer from pricing.fee_revisions
                where tenant_id = ${tenantId}::uuid) as "revisionCount",
              (select count(*)::integer from pricing.fee_schedule_revisions
                where tenant_id = ${tenantId}::uuid) as "scheduleRevisionCount"`,
        'objects',
      );
      const noOp = yield* withPersistence(runtime, legalEntityId, (persistence) => persistence.revise(noOpCommand));
      expect(noOp.outcome).toBe('COMMERCIAL_FEE_UNCHANGED');
      const exactNoOpReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise(noOpCommand),
      );
      expect(exactNoOpReplay.outcome).toBe('COMMERCIAL_FEE_UNCHANGED');
      const changedNoOpReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...noOpCommand,
          configuredAmount: { amount: '24', currencyCode: 'CZK' },
        }),
      );
      expect(changedNoOpReplay).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });

      const crossProcedureDefine = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.define({
          actingPrincipalId: principalId,
          actionInvocationId: noOpInvocationId,
          catalogTargetEvidence: catalogTargetEvidenceFor(),
          configuredAmount: { amount: '9', currencyCode: 'CZK' },
          effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
          identityKey: {
            ...identityFor('RECYCLING_FEE'),
            commercialScope: {
              ...identityFor('RECYCLING_FEE').commercialScope,
              marketId: 'sk-launch',
            },
          },
          reason: 'Reject cross-procedure reuse of the no-op invocation.',
          requestCorrelationId: 'commercial-fee:no-op-define-reuse',
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      expect(crossProcedureDefine).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });

      const defineFirstReviseReuse = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...noOpCommand,
          actionInvocationId: 'e7730000-0000-4000-8000-000000000010',
          configuredAmount: { amount: '25', currencyCode: 'CZK' },
        }),
      );
      expect(defineFirstReviseReuse).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });
      const defineFirstChangedDefineReuse = yield* define(
        'RECYCLING_FEE',
        '25',
        'e7730000-0000-4000-8000-000000000010',
      );
      expect(defineFirstChangedDefineReuse).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });
      const noOpCountsAfter = yield* admin.execute<{
        readonly feeCount: number;
        readonly headCount: number;
        readonly receiptCount: number;
        readonly revisionCount: number;
        readonly scheduleRevisionCount: number;
      }>(
        sql`select
              (select count(*)::integer from pricing.fees
                where tenant_id = ${tenantId}::uuid) as "feeCount",
              (select count(*)::integer from pricing.fee_schedule_heads
                where tenant_id = ${tenantId}::uuid) as "headCount",
              (select count(*)::integer from pricing.fee_action_invocation_receipts
                where tenant_id = ${tenantId}::uuid) as "receiptCount",
              (select count(*)::integer from pricing.fee_revisions
                where tenant_id = ${tenantId}::uuid) as "revisionCount",
              (select count(*)::integer from pricing.fee_schedule_revisions
                where tenant_id = ${tenantId}::uuid) as "scheduleRevisionCount"`,
        'objects',
      );
      expect(noOpCountsAfter).toEqual([
        {
          ...noOpCountsBefore[0],
          receiptCount: (noOpCountsBefore[0]?.receiptCount ?? 0) + 1,
        },
      ]);

      const sameValueSuccessor = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...noOpCommand,
          actionInvocationId: 'e7730000-0000-4000-8000-000000000016',
          effectiveFrom: '2026-09-27T11:30:00.000Z',
          reason: 'Create a same-value successor at a new effective boundary.',
          requestCorrelationId: 'commercial-fee:same-value-successor',
          trustedOperationAt: instant('2026-09-27T12:00:00.000Z'),
        }),
      );
      expect(sameValueSuccessor.outcome).toBe('COMMERCIAL_FEE_REVISED');
      if (sameValueSuccessor.outcome !== 'COMMERCIAL_FEE_REVISED') {
        throw new Error('Expected a same-value Commercial Fee successor at the new boundary');
      }
      expect(sameValueSuccessor.schedule.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: '2026-09-27T11:00:00.000Z' },
        { effectiveFrom: '2026-09-27T11:00:00.000Z', effectiveTo: '2026-09-27T11:30:00.000Z' },
        { effectiveFrom: '2026-09-27T11:30:00.000Z', effectiveTo: null },
      ]);

      const crossSle = yield* withPersistence(runtime, otherLegalEntityId, (persistence) =>
        persistence.readCurrent({
          effectiveAt: '2026-09-27T11:00:00.000Z',
          identityKey: identityFor('RECYCLING_FEE'),
        }),
      );
      expect(crossSle.outcome).toBe('COMMERCIAL_FEE_CURRENT_ABSENT');

      const counts = yield* admin.execute<{
        readonly feeCount: number;
        readonly receiptCount: number;
        readonly revisionCount: number;
      }>(
        sql`select
              (select count(*)::integer from pricing.fees where tenant_id = ${tenantId}::uuid) as "feeCount",
              (select count(*)::integer from pricing.fee_action_invocation_receipts
                where tenant_id = ${tenantId}::uuid) as "receiptCount",
              (select count(*)::integer from pricing.fee_revisions where tenant_id = ${tenantId}::uuid)
                as "revisionCount"`,
        'objects',
      );
      expect(counts).toEqual([{ feeCount: 2, receiptCount: 1, revisionCount: 4 }]);
    }),
  ),
);

it.live('preserves Current end, gap, and future Fee revision behind exact acknowledgement', () =>
  Effect.scoped(
    Effect.gen(function* commercialFeeScheduleProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
      const identityKey = identityFor('RECYCLING_FEE', {
        kind: 'FIXED_PER_UNIT',
        unitBasis: { quantity: '1', unitRef },
      });

      yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.define({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7730000-0000-4000-8000-000000000020',
          catalogTargetEvidence: catalogTargetEvidenceFor(),
          configuredAmount: { amount: '5', currencyCode: 'CZK' },
          effectivePeriod: {
            effectiveFrom: '2026-09-27T10:00:00.000Z',
            effectiveTo: '2026-09-27T12:00:00.000Z',
          },
          identityKey,
          reason: 'Define the initial per-Unit Fee.',
          requestCorrelationId: 'commercial-fee:define',
          trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
        }),
      );
      const scheduled = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7730000-0000-4000-8000-000000000021',
          catalogTargetEvidence: catalogTargetEvidenceFor(),
          configuredAmount: { amount: '7', currencyCode: 'CZK' },
          effectivePeriod: {
            effectiveFrom: '2026-09-27T14:00:00.000Z',
            effectiveTo: '2026-09-27T16:00:00.000Z',
          },
          expectedScheduleRevision: 1,
          identityKey,
          intent: 'SCHEDULE_REVISION',
          reason: 'Schedule a future Fee without filling the gap.',
          requestCorrelationId: 'commercial-fee:schedule',
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      expect(scheduled.outcome).toBe('COMMERCIAL_FEE_REVISED');
      if (scheduled.outcome !== 'COMMERCIAL_FEE_REVISED') {
        throw new Error('Expected a scheduled Commercial Fee revision');
      }
      const { current } = scheduled.schedule;
      if (current === undefined) {
        throw new Error('Expected a Current Commercial Fee revision');
      }
      const expectedCurrent: ExpectedPricingCommercialFeeCurrent = {
        effectivePeriod: current.effectivePeriod,
        feeRef: current.definition.feeRef,
        identityKey,
        revision: current.definition.revision.revision,
        revisionId: current.definition.revision.revisionId,
        scheduleRevision: scheduled.schedule.scheduleRevision,
      };
      const sameValueCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7730000-0000-4000-8000-000000000023',
        catalogTargetEvidence: catalogTargetEvidenceFor(),
        configuredAmount: { amount: '5', currencyCode: 'CZK' },
        effectiveFrom: current.effectivePeriod.effectiveFrom,
        expectedCurrent,
        identityKey,
        intent: 'VALUE_ONLY_CURRENT' as const,
        reason: 'Keep the Current Fee while acknowledging its future schedule.',
        requestCorrelationId: 'commercial-fee:same-value-current',
        trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
      };
      const sameValueChallenge = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise(sameValueCommand),
      );
      expect(sameValueChallenge.outcome).toBe('COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED');
      if (sameValueChallenge.outcome !== 'COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED') {
        throw new Error('Expected same-value Current Fee acknowledgement');
      }
      const forged = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...sameValueCommand,
          acknowledgement: { ...sameValueChallenge.acknowledgement, fingerprint: '0'.repeat(64) },
        }),
      );
      expect(forged).toMatchObject({ outcome: 'COMMERCIAL_FEE_CONFLICT', reason: 'ACKNOWLEDGEMENT_STALE' });
      yield* admin.execute(sql`
        delete from pricing.fee_schedule_acknowledgements
         where tenant_id = ${tenantId}::uuid
           and fingerprint = ${sameValueChallenge.acknowledgement.fingerprint}
      `);
      const unissued = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({ ...sameValueCommand, acknowledgement: sameValueChallenge.acknowledgement }),
      );
      expect(unissued).toMatchObject({ outcome: 'COMMERCIAL_FEE_CONFLICT', reason: 'ACKNOWLEDGEMENT_STALE' });
      const reissued = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise(sameValueCommand),
      );
      if (reissued.outcome !== 'COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED') {
        throw new Error('Expected Commercial Fee acknowledgement reissuance');
      }
      const unchanged = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({ ...sameValueCommand, acknowledgement: reissued.acknowledgement }),
      );
      expect(unchanged).toMatchObject({
        outcome: 'COMMERCIAL_FEE_UNCHANGED',
        schedule: { scheduleRevision: scheduled.schedule.scheduleRevision },
      });
      if (unchanged.outcome !== 'COMMERCIAL_FEE_UNCHANGED') {
        throw new Error('Expected the acknowledged same-value Commercial Fee to remain unchanged');
      }
      expect(unchanged.schedule.future).toEqual(scheduled.schedule.future);

      const challenge = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7730000-0000-4000-8000-000000000022',
          catalogTargetEvidence: catalogTargetEvidenceFor(),
          configuredAmount: { amount: '6', currencyCode: 'CZK' },
          effectiveFrom: '2026-09-27T11:00:00.000Z',
          expectedCurrent,
          identityKey,
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Edit only the Current Fee value.',
          requestCorrelationId: 'commercial-fee:value-only',
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      expect(challenge.outcome).toBe('COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED');
      if (challenge.outcome !== 'COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED') {
        throw new Error('Expected an exact future-schedule acknowledgement');
      }
      const revised = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          acknowledgement: challenge.acknowledgement,
          actingPrincipalId: principalId,
          actionInvocationId: 'e7730000-0000-4000-8000-000000000022',
          catalogTargetEvidence: catalogTargetEvidenceFor(),
          configuredAmount: { amount: '6', currencyCode: 'CZK' },
          effectiveFrom: '2026-09-27T11:00:00.000Z',
          expectedCurrent,
          identityKey,
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Edit only the Current Fee value.',
          requestCorrelationId: 'commercial-fee:value-only',
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      expect(revised.outcome).toBe('COMMERCIAL_FEE_REVISED');
      if (revised.outcome !== 'COMMERCIAL_FEE_REVISED') {
        throw new Error('Expected an acknowledged Current Fee edit');
      }
      expect(revised.schedule.current?.effectivePeriod).toEqual({
        effectiveFrom: '2026-09-27T11:00:00.000Z',
        effectiveTo: current.effectivePeriod.effectiveTo,
      });
      expect(revised.schedule.current?.definition.revision.configuredAmount.amount).toBe('6.000000000');
      expect(revised.schedule.future).toEqual(scheduled.schedule.future);
      expect(revised.schedule.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: '2026-09-27T11:00:00.000Z' },
        { effectiveFrom: '2026-09-27T11:00:00.000Z', effectiveTo: '2026-09-27T12:00:00.000Z' },
        { effectiveFrom: '2026-09-27T14:00:00.000Z', effectiveTo: '2026-09-27T16:00:00.000Z' },
      ]);
    }),
  ),
);

it.live('corrects one exact Fee revision and retires Current without changing future schedule', () =>
  Effect.scoped(
    Effect.gen(function* commercialFeeManagementProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
      const identityKey = identityFor('RECYCLING_FEE');

      yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.define({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000001',
          catalogTargetEvidence: catalogTargetEvidenceFor(),
          configuredAmount: { amount: '5', currencyCode: 'CZK' },
          effectivePeriod: {
            effectiveFrom: '2026-09-27T10:00:00.000Z',
            effectiveTo: '2026-09-27T13:00:00.000Z',
          },
          identityKey,
          reason: 'Define a Fee before management transitions.',
          requestCorrelationId: 'commercial-fee:management:define',
          trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
        }),
      );
      const scheduled = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000002',
          catalogTargetEvidence: catalogTargetEvidenceFor(),
          configuredAmount: { amount: '9', currencyCode: 'CZK' },
          effectivePeriod: {
            effectiveFrom: '2026-09-27T15:00:00.000Z',
            effectiveTo: '2026-09-27T17:00:00.000Z',
          },
          expectedScheduleRevision: 1,
          identityKey,
          intent: 'SCHEDULE_REVISION',
          reason: 'Preserve this future Fee behind a gap.',
          requestCorrelationId: 'commercial-fee:management:schedule',
          trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
        }),
      );
      if (scheduled.outcome !== 'COMMERCIAL_FEE_REVISED' || scheduled.schedule.current === undefined) {
        throw new Error('Expected a Current Fee with one future revision');
      }
      const originalCurrent = scheduled.schedule.current;
      const correctedCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000003',
        catalogTargetEvidence: originalCurrent.definition.catalogTargetEvidence,
        configuredAmount: { amount: '6', currencyCode: 'CZK' as const },
        expectedScheduleRevision: scheduled.schedule.scheduleRevision,
        identityKey,
        intent: 'CORRECT_REVISION' as const,
        reason: 'Correct the exact Current Fee revision.',
        requestCorrelationId: 'commercial-fee:management:correct',
        targetEffectivePeriod: originalCurrent.effectivePeriod,
        targetRevisionId: originalCurrent.definition.revision.revisionId,
        trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
      };
      const crossTenantCorrection = yield* withTenantPersistence(runtime, otherTenantId, legalEntityId, (persistence) =>
        persistence.revise(correctedCommand),
      );
      expect(crossTenantCorrection).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });
      const corrected = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise(correctedCommand),
      );
      expect(corrected.outcome).toBe('COMMERCIAL_FEE_REVISED');
      if (corrected.outcome !== 'COMMERCIAL_FEE_REVISED' || corrected.schedule.current === undefined) {
        throw new Error('Expected a corrected Current Fee');
      }
      expect(corrected.schedule.current).toMatchObject({
        definition: {
          catalogTargetEvidence: originalCurrent.definition.catalogTargetEvidence,
          revision: { configuredAmount: { amount: '6.000000000', currencyCode: 'CZK' } },
        },
        effectivePeriod: originalCurrent.effectivePeriod,
        lineage: {
          correctedRevisionId: originalCurrent.definition.revision.revisionId,
          kind: 'CORRECTION',
          previousRevisionId: originalCurrent.definition.revision.revisionId,
        },
      });
      expect(corrected.schedule.future).toEqual(scheduled.schedule.future);
      expect(corrected.schedule.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: '2026-09-27T13:00:00.000Z' },
        { effectiveFrom: '2026-09-27T15:00:00.000Z', effectiveTo: '2026-09-27T17:00:00.000Z' },
      ]);

      const exactCorrectionReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise(correctedCommand),
      );
      expect(exactCorrectionReplay).toEqual(corrected);
      const changedCorrectionReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...correctedCommand,
          configuredAmount: { amount: '7', currencyCode: 'CZK' },
        }),
      );
      expect(changedCorrectionReplay).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });

      const staleCorrection = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...correctedCommand,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000004',
        }),
      );
      expect(staleCorrection).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'EXPECTED_SCHEDULE_STALE',
      });
      const correctedCurrent = corrected.schedule.current;
      const expectedCurrent: ExpectedPricingCommercialFeeCurrent = {
        effectivePeriod: correctedCurrent.effectivePeriod,
        feeRef: correctedCurrent.definition.feeRef,
        identityKey,
        revision: correctedCurrent.definition.revision.revision,
        revisionId: correctedCurrent.definition.revision.revisionId,
        scheduleRevision: corrected.schedule.scheduleRevision,
      };
      const changedCorrectionBoundary = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...correctedCommand,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000008',
          expectedScheduleRevision: corrected.schedule.scheduleRevision,
          targetEffectivePeriod: {
            ...correctedCurrent.effectivePeriod,
            effectiveTo: '2026-09-27T12:30:00.000Z',
          },
          targetRevisionId: correctedCurrent.definition.revision.revisionId,
        }),
      );
      expect(changedCorrectionBoundary).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'EFFECTIVE_BOUNDARY_STALE',
      });
      const changedCorrectionEvidence = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...correctedCommand,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000006',
          catalogTargetEvidence: {
            ...correctedCurrent.definition.catalogTargetEvidence,
            snapshotId: 'catalog:snapshot:forged-correction',
          },
          expectedScheduleRevision: corrected.schedule.scheduleRevision,
          targetRevisionId: correctedCurrent.definition.revision.revisionId,
        }),
      );
      expect(changedCorrectionEvidence).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });
      const missingCorrectionTarget = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...correctedCommand,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000007',
          catalogTargetEvidence: correctedCurrent.definition.catalogTargetEvidence,
          expectedScheduleRevision: corrected.schedule.scheduleRevision,
          targetRevisionId: 'e7970000-0000-4000-8000-000000000098',
        }),
      );
      expect(missingCorrectionTarget).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'TARGET_REVISION_NOT_FOUND',
      });
      const retireCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7970000-0000-4000-8000-000000000005',
        effectiveTo: '2026-09-27T11:30:00.000Z',
        expectedCurrent,
        identityKey,
        intent: 'RETIRE_CURRENT' as const,
        reason: 'End only the Current Fee and retain the future schedule.',
        requestCorrelationId: 'commercial-fee:management:retire',
        trustedOperationAt: instant('2026-09-27T11:30:00.000Z'),
      };
      const retirementChallenge = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise(retireCommand),
      );
      expect(retirementChallenge.outcome).toBe('COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED');
      if (retirementChallenge.outcome !== 'COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED') {
        throw new Error('Expected retirement to require exact future-schedule acknowledgement');
      }
      expect(retirementChallenge.acknowledgement).toMatchObject({
        actingPrincipalId: principalId,
        intendedConfiguredAmount: { amount: '6.000000000', currencyCode: 'CZK' },
        intent: 'RETIRE_CURRENT',
        presentedFuture: corrected.schedule.future,
        scheduleRevision: corrected.schedule.scheduleRevision,
        targetRevisionId: correctedCurrent.definition.revision.revisionId,
      });
      const retired = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...retireCommand,
          acknowledgement: retirementChallenge.acknowledgement,
        }),
      );
      expect(retired.outcome).toBe('COMMERCIAL_FEE_REVISED');
      if (retired.outcome !== 'COMMERCIAL_FEE_REVISED') {
        throw new Error('Expected an acknowledged Current Fee retirement');
      }
      expect(retired.schedule.current).toBeUndefined();
      expect(retired.schedule.future).toEqual(corrected.schedule.future);
      expect(retired.schedule.revisions.map(({ effectivePeriod }) => effectivePeriod)).toEqual([
        { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: '2026-09-27T11:30:00.000Z' },
        { effectiveFrom: '2026-09-27T15:00:00.000Z', effectiveTo: '2026-09-27T17:00:00.000Z' },
      ]);
      const exactRetirementReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({ ...retireCommand, acknowledgement: retirementChallenge.acknowledgement }),
      );
      expect(exactRetirementReplay).toEqual(retired);
      const changedRetirementBoundaryReplay = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.revise({
          ...retireCommand,
          acknowledgement: retirementChallenge.acknowledgement,
          effectiveTo: '2026-09-27T11:45:00.000Z',
        }),
      );
      expect(changedRetirementBoundaryReplay).toMatchObject({
        outcome: 'COMMERCIAL_FEE_CONFLICT',
        reason: 'IDENTITY_MISMATCH',
      });

      const transitions = yield* admin.execute<{
        readonly correctedRevisionId: null | string;
        readonly previousRevisionId: null | string;
        readonly transitionKind: string;
      }>(
        sql`select corrected_revision_id::text as "correctedRevisionId",
                   previous_revision_id::text as "previousRevisionId",
                   transition_kind as "transitionKind"
              from pricing.fee_revisions
             where tenant_id = ${tenantId}::uuid
               and action_invocation_id in (
                 'e7970000-0000-4000-8000-000000000003'::uuid,
                 'e7970000-0000-4000-8000-000000000005'::uuid
               )
             order by revision_number`,
        'objects',
      );
      expect(transitions).toEqual([
        {
          correctedRevisionId: originalCurrent.definition.revision.revisionId,
          previousRevisionId: originalCurrent.definition.revision.revisionId,
          transitionKind: 'CORRECTION',
        },
        {
          correctedRevisionId: null,
          previousRevisionId: correctedCurrent.definition.revision.revisionId,
          transitionKind: 'RETIREMENT',
        },
      ]);
    }),
  ),
);

it.live('serializes competing exact Fee corrections and leaves one schedule winner', () =>
  Effect.scoped(
    Effect.gen(function* commercialFeeCorrectionConcurrencyProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
      const identityKey = identityFor('COPYRIGHT_FEE');
      yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.define({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7970000-0000-4000-8000-000000000010',
          catalogTargetEvidence: catalogTargetEvidenceFor(),
          configuredAmount: { amount: '1', currencyCode: 'CZK' },
          effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
          identityKey,
          reason: 'Define the concurrently corrected Fee.',
          requestCorrelationId: 'commercial-fee:concurrent:define',
          trustedOperationAt: instant('2026-09-27T09:00:00.000Z'),
        }),
      );
      const current = yield* withPersistence(runtime, legalEntityId, (persistence) =>
        persistence.readCurrent({ effectiveAt: '2026-09-27T11:00:00.000Z', identityKey }),
      );
      if (current.outcome !== 'COMMERCIAL_FEE_CURRENT') {
        throw new Error('Expected the concurrently corrected Fee to be Current');
      }
      const commandFor = (amount: string, actionInvocationId: string) => ({
        actingPrincipalId: principalId,
        actionInvocationId,
        catalogTargetEvidence: current.revision.definition.catalogTargetEvidence,
        configuredAmount: { amount, currencyCode: 'CZK' as const },
        expectedScheduleRevision: 1,
        identityKey,
        intent: 'CORRECT_REVISION' as const,
        reason: `Correct concurrently to ${amount}.`,
        requestCorrelationId: `commercial-fee:concurrent:${amount}`,
        targetEffectivePeriod: current.revision.effectivePeriod,
        targetRevisionId: current.revision.definition.revision.revisionId,
        trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
      });
      const outcomes = yield* Effect.all(
        [
          withPersistence(runtime, legalEntityId, (persistence) =>
            persistence.revise(commandFor('2', 'e7970000-0000-4000-8000-000000000011')),
          ),
          withPersistence(runtime, legalEntityId, (persistence) =>
            persistence.revise(commandFor('3', 'e7970000-0000-4000-8000-000000000012')),
          ),
        ],
        { concurrency: 'unbounded' },
      );
      expect(outcomes.map(({ outcome }) => outcome).toSorted()).toEqual([
        'COMMERCIAL_FEE_CONFLICT',
        'COMMERCIAL_FEE_REVISED',
      ]);
      expect(outcomes.find(({ outcome }) => outcome === 'COMMERCIAL_FEE_CONFLICT')).toMatchObject({
        reason: 'EXPECTED_SCHEDULE_STALE',
      });
      const counts = yield* admin.execute<{ readonly revisionCount: number; readonly scheduleRevisionCount: number }>(
        sql`select
              (select count(*)::integer from pricing.fee_revisions
                where tenant_id = ${tenantId}::uuid) as "revisionCount",
              (select count(*)::integer from pricing.fee_schedule_revisions
                where tenant_id = ${tenantId}::uuid) as "scheduleRevisionCount"`,
        'objects',
      );
      expect(counts).toEqual([{ revisionCount: 2, scheduleRevisionCount: 2 }]);
    }),
  ),
);
