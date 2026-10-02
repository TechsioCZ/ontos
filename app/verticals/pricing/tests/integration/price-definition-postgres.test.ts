import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { PriceProductTargetSnapshotSchema } from '@app/pricing-contracts/domain/catalog-price-target';
import {
  ExactPriceConflictDiagnosticSchema,
  ExactPriceLookupAbsentSchema,
  ExactPriceLookupFoundSchema,
  ExactPriceLookupInvalidSchema,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import type { PriceSourceEvidence } from '@app/pricing-contracts/domain/price-source-provenance';
import type { PriceRef } from '@app/pricing-contracts/resources/price';
import { sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type {
  DefinePricePersistenceOutcome,
  DefinePricePersistenceCommand,
  ExactPriceLookupPersistence,
  PriceActionResultLookupOutcome,
  PriceActionResultLookupPersistence,
  PricePersistence,
  RevisePricePersistenceCommand,
} from '../../src/services/price-persistence.service.ts';
import {
  DefinePricePersistenceOutcomeSchema,
  PricePersistenceUnavailable,
  pricePersistenceForScope,
} from '../../src/services/price-persistence.service.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';
import { makeProductPriceBulkService } from '../../src/services/product-price-bulk.service.ts';
import type {
  ProductPriceBulkCommandPort,
  ProductPriceBulkOwnerOutcome,
  ProductPriceBulkTargetIntent,
} from '../../src/services/product-price-bulk-command.port.ts';
import { productPriceBulkActionInvocationIdFor } from '../../src/services/product-price-bulk-command.port.ts';

const tenantId = 'e7550000-0000-4000-8000-000000000001';
const legalEntityId = 'e7550000-0000-4000-8000-000000000002';
const otherLegalEntityId = 'e7550000-0000-4000-8000-00000000000e';
const principalId = 'e7550000-0000-4000-8000-000000000003';
const alternatePrincipalId = 'e7550000-0000-4000-8000-000000000004';
const firstPriceId = 'e7550000-0000-4000-8000-000000000005';
const concurrentPriceId = 'e7550000-0000-4000-8000-000000000006';
const firstInvocationId = 'e7550000-0000-4000-8000-000000000007';
const concurrentInvocationId = 'e7550000-0000-4000-8000-000000000008';
const alternatePriceId = 'e7550000-0000-4000-8000-00000000000d';
const scheduledPriceId = 'e7560000-0000-4000-8000-000000000020';
const finitePriceId = 'e7560000-0000-4000-8000-000000000021';
const concurrentEditPriceId = 'e7560000-0000-4000-8000-000000000022';
const concurrentRetirementPriceId = 'e7560000-0000-4000-8000-000000000023';
const exactStartOpenPriceId = 'e7560000-0000-4000-8000-000000000025';
const exactStartFinitePriceId = 'e7560000-0000-4000-8000-000000000026';
const exactLookupSupportId = 'e7630000-0000-4000-8000-000000000001';
const exactLookupSupportRevisionId = 'e7630000-0000-4000-8000-000000000002';
const exactLookupSupportScheduleId = 'e7630000-0000-4000-8000-000000000003';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];
type WithoutSourceProvenance<Command> = Command extends unknown
  ? Omit<Command, 'requestCorrelationId' | 'sourceEvidence'>
  : never;
type LegacyRevisePricePersistenceCommand = WithoutSourceProvenance<RevisePricePersistenceCommand>;
type TestPricePersistence = ExactPriceLookupPersistence &
  PriceActionResultLookupPersistence &
  Omit<PricePersistence, 'revise'> & {
    readonly revise: ReturnType<PricePersistence['revise']> extends Effect.Effect<infer Success, unknown, unknown>
      ? (
          command: LegacyRevisePricePersistenceCommand | RevisePricePersistenceCommand,
        ) => Effect.Effect<Success, EffectDrizzleQueryError | PricePersistenceUnavailable>
      : never;
  };

const priceRef = (resourceId: string): PriceRef => ({
  moduleId: 'commerce.pricing',
  resourceId,
  resourceType: 'commerce.pricing.price',
  tenantId,
});
const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const identityKey: PriceIdentityKey = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: 'e7550000-0000-4000-8000-000000000009',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: 'e7550000-0000-4000-8000-00000000000a',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' },
  unitBasis: {
    quantity: '1.000000000',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: 'e7550000-0000-4000-8000-00000000000b',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
};
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'e7550000-0000-4000-8000-00000000000c',
    authContextRef: 'session:price-definition-postgres',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'price-definition-postgres',
};
const alternateScope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'e7560000-0000-4000-8000-000000000024',
    authContextRef: 'session:price-definition-postgres-alternate',
    authMethod: 'session',
    legalEntityId,
    principalId: alternatePrincipalId,
    tenantId,
  }),
  correlationId: 'price-definition-postgres-alternate',
};
const otherLegalEntityScope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'e7550000-0000-4000-8000-00000000000f',
    authContextRef: 'session:price-definition-postgres-other-legal-entity',
    authMethod: 'session',
    legalEntityId: otherLegalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'price-definition-postgres-other-legal-entity',
};
const definitionSourceEvidence = (input: {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly effectiveFrom: string;
  readonly identityKey: PriceIdentityKey;
  readonly monetaryAmount: DefinePricePersistenceCommand['monetaryAmount'];
  readonly trustedOperationAt: Date;
}): PriceSourceEvidence => {
  const { identityKey: exactIdentity } = input;
  const sourceAssertion = Schema.decodeSync(PriceSourceAssertionInputSchema)({
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'pricing-integration-v2', mappingContractVersion: '2' },
    originalAssertion: {
      monetaryAmount: input.monetaryAmount,
      monetaryBoundary: 'PRE_TAX',
      unitBasis: exactIdentity.unitBasis,
    },
    sourceAssertionId: input.actionInvocationId,
    sourceAuthority: { sourceAuthorityRef: 'pricing-integration-owner', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: [
        exactIdentity.catalogSelection.productRef.resourceId,
        exactIdentity.catalogSelection.variantRef.resourceId,
        exactIdentity.commercialScope.sellingLegalEntityId,
        exactIdentity.commercialScope.channelId,
        exactIdentity.commercialScope.marketId,
        exactIdentity.currencyCode,
        exactIdentity.unitBasis.unitRef.resourceId,
        exactIdentity.unitBasis.quantity,
        exactIdentity.priceGroupSelector.kind,
        exactIdentity.priceGroupSelector.kind === 'PRICE_GROUP'
          ? exactIdentity.priceGroupSelector.priceGroupRef.resourceId
          : 'NO_GROUP',
        input.monetaryAmount.amount,
        input.effectiveFrom,
      ].join(':'),
      sourceRecordRef: [
        exactIdentity.catalogSelection.productRef.resourceId,
        exactIdentity.catalogSelection.variantRef.resourceId,
        exactIdentity.unitBasis.unitRef.resourceId,
      ].join(':'),
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'pricing-integration' },
    },
    timing: {
      importedAt: input.trustedOperationAt.toISOString(),
      ownerBusinessEffectiveAt: input.effectiveFrom,
      sourceEffectiveAt: input.effectiveFrom,
    },
  });
  const prepared = preparePriceSourceEvidence({
    ...input,
    sourceAssertion,
    tenantId,
  });
  if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
    throw new Error(`Expected ready definition source evidence, received ${prepared.outcome}`);
  }
  return prepared.evidence;
};
const command = (
  actionInvocationId: string,
  resourceId: string,
  overrides: Partial<DefinePricePersistenceCommand> = {},
): DefinePricePersistenceCommand => {
  const requested = {
    actingPrincipalId: principalId,
    actionInvocationId,
    effectiveFrom: '2026-09-27T10:00:00.000Z',
    identityKey,
    monetaryAmount: { amount: '123.456789123', currencyCode: 'CZK' },
    priceRef: priceRef(resourceId),
    reason: 'Define the canonical launch Price.',
    trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T10:00:01.000Z')),
    ...overrides,
  } satisfies Omit<DefinePricePersistenceCommand, 'requestCorrelationId' | 'sourceEvidence'> &
    Partial<Pick<DefinePricePersistenceCommand, 'requestCorrelationId' | 'sourceEvidence'>>;
  return {
    ...requested,
    requestCorrelationId: requested.requestCorrelationId ?? `price-definition:${actionInvocationId}`,
    sourceEvidence:
      requested.sourceEvidence ??
      definitionSourceEvidence({
        actingPrincipalId: requested.actingPrincipalId,
        actionInvocationId: requested.actionInvocationId,
        effectiveFrom: requested.effectiveFrom,
        identityKey: requested.identityKey,
        monetaryAmount: requested.monetaryAmount,
        trustedOperationAt: requested.trustedOperationAt,
      }),
  };
};

const revisionSourceEvidence = (
  revisionCommand: Exclude<LegacyRevisePricePersistenceCommand, { readonly intent: 'RETIRE_CURRENT' }>,
  predecessorSourceAssertionId: string,
  ownerBusinessEffectiveAt: string,
  unitBasis: PriceIdentityKey['unitBasis'],
): PriceSourceEvidence => {
  const lineage =
    revisionCommand.intent === 'CORRECT_REVISION'
      ? {
          correctedSourceAssertionId: predecessorSourceAssertionId,
          kind: 'CORRECTION' as const,
          reason: revisionCommand.reason,
        }
      : {
          kind: 'SUPERSESSION' as const,
          reason: revisionCommand.reason,
          supersededSourceAssertionId: predecessorSourceAssertionId,
        };
  const sourceAssertion = Schema.decodeSync(PriceSourceAssertionInputSchema)({
    lineage,
    mapping: { mappingContractRef: 'pricing-integration-v2', mappingContractVersion: '2' },
    originalAssertion: {
      monetaryAmount: revisionCommand.monetaryAmount,
      monetaryBoundary: 'PRE_TAX',
      unitBasis,
    },
    sourceAssertionId: revisionCommand.actionInvocationId,
    sourceAuthority: { sourceAuthorityRef: 'pricing-integration-owner', sourceAuthorityVersion: '1' },
    sourceRecord: {
      sourceChangeCorrelation: revisionCommand.actionInvocationId,
      sourceRecordRef: `price-revision:${revisionCommand.actionInvocationId}`,
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'pricing-integration' },
    },
    timing: {
      importedAt: revisionCommand.trustedOperationAt.toISOString(),
      ownerBusinessEffectiveAt,
      sourceEffectiveAt: ownerBusinessEffectiveAt,
    },
  });
  const prepared = preparePriceSourceEvidence({
    actingPrincipalId: revisionCommand.actingPrincipalId,
    effectiveFrom: ownerBusinessEffectiveAt,
    monetaryAmount: revisionCommand.monetaryAmount,
    sourceAssertion,
    tenantId,
    trustedOperationAt: revisionCommand.trustedOperationAt,
  });
  if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
    throw new Error(`Expected ready revision source evidence, received ${prepared.outcome}`);
  }
  return prepared.evidence;
};

const enrichRevisionCommand = (
  transaction: PricingTransaction,
  revisionCommand: LegacyRevisePricePersistenceCommand | RevisePricePersistenceCommand,
) => {
  if (
    'requestCorrelationId' in revisionCommand &&
    (revisionCommand.intent === 'RETIRE_CURRENT' || 'sourceEvidence' in revisionCommand)
  ) {
    return Effect.succeed(revisionCommand);
  }
  if (revisionCommand.intent === 'RETIRE_CURRENT') {
    return Effect.succeed({
      ...revisionCommand,
      requestCorrelationId: `price-revision:${revisionCommand.actionInvocationId}`,
    } satisfies RevisePricePersistenceCommand);
  }
  return Effect.gen(function* enrichSourceProvenance() {
    let revisionId: string | undefined;
    if (revisionCommand.intent === 'VALUE_ONLY_CURRENT') {
      ({ revisionId } = revisionCommand.expectedCurrent);
    } else if (revisionCommand.intent === 'CORRECT_REVISION') {
      revisionId = revisionCommand.targetRevisionId;
    }
    const directRows =
      revisionId === undefined
        ? []
        : yield* transaction.execute<{
            readonly basisQuantity: string;
            readonly effectiveFrom: Date;
            readonly sourceAssertionId: string;
            readonly unitRef: PriceIdentityKey['unitBasis']['unitRef'];
          }>(
            sql`select revision.effective_from as "effectiveFrom",
                       assertion.source_assertion_id as "sourceAssertionId",
                       price.unit_ref as "unitRef", price.basis_quantity::text as "basisQuantity"
                  from pricing.price_revisions as revision
                  join pricing.prices as price
                    on price.tenant_id = revision.tenant_id
                   and price.legal_entity_id = revision.legal_entity_id
                   and price.price_id = revision.price_id
                  join pricing.price_source_assertions as assertion
                    on assertion.tenant_id = revision.tenant_id
                   and assertion.legal_entity_id = revision.legal_entity_id
                   and assertion.price_id = revision.price_id
                   and assertion.price_revision_id = revision.price_revision_id
                 where revision.tenant_id = ${tenantId}::uuid
                   and revision.legal_entity_id = ${legalEntityId}::uuid
                   and revision.price_id = ${revisionCommand.priceRef.resourceId}::uuid
                   and revision.price_revision_id = ${revisionId}::uuid`,
            'objects',
          );
    const scheduledRows =
      revisionCommand.intent === 'SCHEDULE_REVISION'
        ? yield* transaction.execute<{
            readonly basisQuantity: string;
            readonly effectiveFrom: Date;
            readonly effectiveTo: Date | null;
            readonly sourceAssertionId: string;
            readonly unitRef: PriceIdentityKey['unitBasis']['unitRef'];
          }>(
            sql`select entry.effective_from as "effectiveFrom", entry.effective_to as "effectiveTo",
                       assertion.source_assertion_id as "sourceAssertionId",
                       price.unit_ref as "unitRef", price.basis_quantity::text as "basisQuantity"
                  from pricing.price_schedule_heads as head
                  join pricing.price_schedule_entries as entry
                    on entry.tenant_id = head.tenant_id
                   and entry.legal_entity_id = head.legal_entity_id
                   and entry.price_id = head.price_id
                   and entry.price_schedule_revision_id = head.price_schedule_revision_id
                  join pricing.prices as price
                    on price.tenant_id = entry.tenant_id
                   and price.legal_entity_id = entry.legal_entity_id
                   and price.price_id = entry.price_id
                  join pricing.price_source_assertions as assertion
                    on assertion.tenant_id = entry.tenant_id
                   and assertion.legal_entity_id = entry.legal_entity_id
                   and assertion.price_id = entry.price_id
                   and assertion.price_revision_id = entry.price_revision_id
                 where head.tenant_id = ${tenantId}::uuid
                   and head.legal_entity_id = ${legalEntityId}::uuid
                   and head.price_id = ${revisionCommand.priceRef.resourceId}::uuid
                   and entry.effective_from < ${revisionCommand.effectivePeriod.effectiveFrom}::timestamptz
                 order by entry.effective_from desc`,
            'objects',
          )
        : [];
    const fallbackRows = yield* transaction.execute<{
      readonly basisQuantity: string;
      readonly effectiveFrom: Date;
      readonly sourceAssertionId: string;
      readonly unitRef: PriceIdentityKey['unitBasis']['unitRef'];
    }>(
      sql`select revision.effective_from as "effectiveFrom",
                 assertion.source_assertion_id as "sourceAssertionId",
                 price.unit_ref as "unitRef", price.basis_quantity::text as "basisQuantity"
            from pricing.price_source_assertions as assertion
            join pricing.price_revisions as revision
              on revision.tenant_id = assertion.tenant_id
             and revision.legal_entity_id = assertion.legal_entity_id
             and revision.price_id = assertion.price_id
             and revision.price_revision_id = assertion.price_revision_id
            join pricing.prices as price
              on price.tenant_id = assertion.tenant_id
             and price.legal_entity_id = assertion.legal_entity_id
             and price.price_id = assertion.price_id
           where assertion.tenant_id = ${tenantId}::uuid
             and assertion.legal_entity_id = ${legalEntityId}::uuid
             and assertion.price_id = ${revisionCommand.priceRef.resourceId}::uuid
           order by revision.revision_number desc
           limit 1`,
      'objects',
    );
    const predecessor = directRows[0] ?? scheduledRows[0] ?? fallbackRows[0];
    if (predecessor === undefined) {
      return yield* Effect.die('Expected a canonical predecessor for Price revision provenance');
    }
    let ownerBusinessEffectiveAt = predecessor.effectiveFrom.toISOString();
    if (revisionCommand.intent === 'SCHEDULE_REVISION') {
      ownerBusinessEffectiveAt = revisionCommand.effectivePeriod.effectiveFrom;
    } else if (revisionCommand.intent === 'VALUE_ONLY_CURRENT') {
      ownerBusinessEffectiveAt =
        revisionCommand.acknowledgement?.intendedEffectivePeriod.effectiveFrom ??
        revisionCommand.trustedOperationAt.toISOString();
    }
    return {
      ...revisionCommand,
      requestCorrelationId: `price-revision:${revisionCommand.actionInvocationId}`,
      sourceEvidence: revisionSourceEvidence(revisionCommand, predecessor.sourceAssertionId, ownerBusinessEffectiveAt, {
        quantity: predecessor.basisQuantity,
        unitRef: predecessor.unitRef,
      }),
    } satisfies RevisePricePersistenceCommand;
  });
};

const withPersistence = <Value, Failure>(
  database: PricingTestDatabase,
  operation: (persistence: TestPricePersistence) => Effect.Effect<Value, Failure>,
  operationalScope: OperationalScope = scope,
) =>
  database.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* scopedPricePersistence() {
      const selectedLegalEntityId = operationalScope.legalEntityId ?? legalEntityId;
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${selectedLegalEntityId}, true)`,
        'objects',
      );
      const ownerTransaction = yield* installOperationalScope(transaction, operationalScope);
      const persistence = yield* pricePersistenceForScope(ownerTransaction, operationalScope);
      return yield* operation({
        ...persistence,
        revise: (revisionCommand) =>
          enrichRevisionCommand(transaction, revisionCommand).pipe(Effect.flatMap(persistence.revise)),
      });
    }),
  );

const definePriceThroughDeployedV2 = (database: PricingTestDatabase, definition: DefinePricePersistenceCommand) =>
  database.transaction((transaction) =>
    Effect.gen(function* executeDeployedPriceWriter() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
        'objects',
      );
      const encodedDefinition = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(definition);
      const rows = yield* transaction.execute<{ readonly payload: unknown }>(
        sql`select result.payload
              from pricing.define_price_v2(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${encodedDefinition}::jsonb
              ) as result`,
        'objects',
      );
      const [row] = rows;
      return yield* Schema.decodeUnknownEffect(DefinePricePersistenceOutcomeSchema)(row?.payload);
    }),
  );

const cleanupPricingFacts = (admin: PricingTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanPricingFacts() {
      yield* transaction.execute(
        sql`delete from pricing.price_fee_action_result_receipts where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.price_fee_action_invocation_claims where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.price_source_assertion_deliveries where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.price_source_assertions where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(
        sql`delete from pricing.price_invocation_receipts where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.price_schedule_acknowledgements where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.price_schedule_heads where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.price_schedule_entries where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.price_schedule_revisions where tenant_id = ${tenantId}::uuid`);
      yield* transaction.execute(sql`delete from pricing.price_revisions where tenant_id = ${tenantId}::uuid`);
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

const cleanupExactLookupCurrencySupport = (admin: PricingTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanExactLookupCurrencySupport() {
      yield* transaction.execute(
        sql`delete from pricing.currency_support_schedule_heads where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.currency_support_schedule_entries where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.currency_support_schedule_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.currency_support_value_revisions where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(sql`delete from pricing.currency_support_roots where tenant_id = ${tenantId}::uuid`);
    }),
  );

const seedExactLookupCurrencySupport = (admin: PricingTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* seedExactLookupSupport() {
      yield* transaction.execute(sql`
        insert into pricing.currency_support_roots (
          currency_support_id, tenant_id, created_by_action_invocation_id, created_by_principal_id
        ) values (
          ${exactLookupSupportId}::uuid, ${tenantId}::uuid,
          'e7630000-0000-4000-8000-000000000004'::uuid, ${principalId}::uuid
        )
      `);
      yield* transaction.execute(sql`
        insert into pricing.currency_support_value_revisions (
          currency_support_revision_id, tenant_id, currency_support_id, generation, pricing_revision,
          supported_currencies, previous_revision_id, action_invocation_id, acting_principal_id, reason
        ) values (
          ${exactLookupSupportRevisionId}::uuid, ${tenantId}::uuid, ${exactLookupSupportId}::uuid,
          1, 'pricing-currency-support:1', '["CZK"]'::jsonb, null,
          'e7630000-0000-4000-8000-000000000005'::uuid, ${principalId}::uuid,
          'Seed exact Price lookup Currency Support.'
        )
      `);
      yield* transaction.execute(sql`
        insert into pricing.currency_support_schedule_revisions (
          currency_support_schedule_revision_id, tenant_id, currency_support_id, schedule_revision,
          previous_schedule_revision_id, action_invocation_id, acting_principal_id,
          schedule_acknowledgement, reason
        ) values (
          ${exactLookupSupportScheduleId}::uuid, ${tenantId}::uuid, ${exactLookupSupportId}::uuid,
          1, null, 'e7630000-0000-4000-8000-000000000006'::uuid, ${principalId}::uuid,
          null, 'Seed exact Price lookup Currency Support schedule.'
        )
      `);
      yield* transaction.execute(sql`
        insert into pricing.currency_support_schedule_entries (
          tenant_id, currency_support_id, currency_support_revision_id,
          currency_support_schedule_revision_id, schedule_revision, effective_from, effective_to
        ) values (
          ${tenantId}::uuid, ${exactLookupSupportId}::uuid, ${exactLookupSupportRevisionId}::uuid,
          ${exactLookupSupportScheduleId}::uuid, 1, '2026-09-27T00:00:00.000Z'::timestamptz, null
        )
      `);
      yield* transaction.execute(sql`
        insert into pricing.currency_support_schedule_heads (
          tenant_id, currency_support_id, currency_support_schedule_revision_id, schedule_revision
        ) values (
          ${tenantId}::uuid, ${exactLookupSupportId}::uuid, ${exactLookupSupportScheduleId}::uuid, 1
        )
      `);
    }),
  );

const databaseCurrentInstant = (admin: PricingTestDatabase) =>
  admin.transaction((transaction) =>
    transaction
      .execute(
        sql`select to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveAt"`,
        'objects',
      )
      .pipe(
        Effect.map(
          ([row]) => Schema.decodeUnknownSync(Schema.Struct({ effectiveAt: PricingInstantSchema }))(row).effectiveAt,
        ),
      ),
  );

const runTestOnlyExactPriceCollisionFixture = (
  admin: PricingTestDatabase,
  effectiveAt: string,
  amount: string,
  collisionRef: string,
) =>
  admin.transaction((transaction) =>
    Effect.gen(function* classifySyntheticCollision() {
      const duplicatePriceId = 'e7630000-0000-4000-8000-000000000020';
      const duplicateRevisionId = 'e7630000-0000-4000-8000-000000000021';
      const duplicateScheduleId = 'e7630000-0000-4000-8000-000000000022';
      const duplicateSourceAssertionId = `e7630000-0000-4000-8000-00000000002${collisionRef}`;
      const claimant = (
        priceId: string,
        revisionId: string,
        scheduleId: string,
        provenanceRef: string,
        monetaryAmount: string,
      ) => ({
        effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
        exactKey: identityKey,
        priceRef: priceRef(priceId),
        priceRevision: {
          effectiveFrom: '2026-09-27T10:00:00.000Z',
          monetaryAmount: { amount: monetaryAmount, currencyCode: 'CZK' },
          monetaryBoundary: 'PRE_TAX',
          revision: 1,
          revisionId,
        },
        priceScheduleRevisionId: scheduleId,
        provenanceRefs: [provenanceRef],
        scheduleRevision: 1,
      });
      const request = { effectiveAt, exactKey: identityKey };
      const claimants = [
        claimant(
          firstPriceId,
          'e7630000-0000-4000-8000-000000000030',
          'e7630000-0000-4000-8000-000000000031',
          'e7630000-0000-4000-8000-000000000032',
          '123.456789123',
        ),
        claimant(duplicatePriceId, duplicateRevisionId, duplicateScheduleId, duplicateSourceAssertionId, amount),
      ];
      const serializedRequest = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(request);
      const serializedClaimants = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(claimants);
      const [row] = yield* transaction.execute(
        sql`select jsonb_build_object(
              '_tag', 'EXACT_PRICE_CONFLICT_DIAGNOSTIC',
              'claimants', ${serializedClaimants}::jsonb,
              'evidence', jsonb_build_object(
                'effectiveAt', ${effectiveAt}::text,
                'observedAt', ${effectiveAt}::text,
                'ownerRevision', 'test-only-exact-price-conflict-fixture'
              ),
              'reason', 'COMPETING_CURRENT_EXACT_PRICES',
              'request', ${serializedRequest}::jsonb,
              'verification', 'OWNER_VERIFIED_COMPLETE_CURRENT_SET'
            ) as payload`,
        'objects',
      );
      return (yield* Schema.decodeUnknownEffect(Schema.Struct({ payload: ExactPriceConflictDiagnosticSchema }))(row))
        .payload;
    }),
  );

const productPriceBulkOutcomeFromPersistence = (
  result: DefinePricePersistenceOutcome,
): ProductPriceBulkOwnerOutcome => {
  if (result.outcome === 'CREATED' || result.outcome === 'REUSED') {
    return {
      canonical: {
        priceRef: result.definition.priceRef,
        revisionId: result.definition.revision.revisionId,
      },
      outcome: result.outcome === 'CREATED' ? 'APPLIED' : 'UNCHANGED',
    };
  }
  return result.outcome === 'CONFLICT'
    ? { outcome: 'CONFLICT', reasonCode: result.reason }
    : { outcome: 'REJECTED', reasonCode: 'EFFECTIVE_TIME_INVALID' };
};

it.live('binds idempotency to the exact command and serializes concurrent exact-key creation', () =>
  Effect.scoped(
    Effect.gen(function* priceDefinitionPersistenceAcceptance() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanPriceFacts() {
            yield* transaction.execute(
              sql`delete from pricing.price_fee_action_result_receipts where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_fee_action_invocation_claims where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_source_assertion_deliveries where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_source_assertions where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_invocation_receipts where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_schedule_acknowledgements where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_schedule_heads where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_schedule_entries where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_schedule_revisions where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(sql`delete from pricing.price_revisions where tenant_id = ${tenantId}::uuid`);
            yield* transaction.execute(
              sql`delete from pricing.quantity_tier_set_heads where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.quantity_tier_set_revisions where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.quantity_tier_set_roots where tenant_id = ${tenantId}::uuid`,
            );
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
      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const first = command(firstInvocationId, firstPriceId);
      const firstResult = yield* definePriceThroughDeployedV2(runtime, first);
      expect(firstResult).toMatchObject({
        outcome: 'CREATED',
      });
      expect(yield* withPersistence(runtime, (persistence) => persistence.define(first))).toEqual(firstResult);
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.define({ ...first, requestCorrelationId: 'price-definition:lost-response-retry' }),
        ),
      ).toEqual(firstResult);
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.lookupResult({ actionInvocationId: firstInvocationId }),
        ),
      ).toEqual({
        actionInvocationId: firstInvocationId,
        outcome: 'PRICE_ACTION_RESULT_FOUND',
        result: firstResult,
      });
      expect(
        yield* withPersistence(
          runtime,
          (persistence) => persistence.lookupResult({ actionInvocationId: firstInvocationId }),
          alternateScope,
        ),
      ).toEqual({ actionInvocationId: firstInvocationId, outcome: 'PRICE_ACTION_RESULT_ABSENT' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.lookupResult({ actionInvocationId: 'e755ffff-0000-4000-8000-000000000001' }),
        ),
      ).toEqual({
        actionInvocationId: 'e755ffff-0000-4000-8000-000000000001',
        outcome: 'PRICE_ACTION_RESULT_ABSENT',
      });
      const crossLegalEntityIdentity = {
        ...identityKey,
        commercialScope: { ...identityKey.commercialScope, sellingLegalEntityId: otherLegalEntityId },
      };
      expect(
        yield* withPersistence(
          runtime,
          (persistence) =>
            persistence.define(
              command(firstInvocationId, alternatePriceId, {
                identityKey: crossLegalEntityIdentity,
                requestCorrelationId: 'price-definition:cross-legal-entity-reuse',
              }),
            ),
          otherLegalEntityScope,
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'IDEMPOTENCY_CONFLICT' });
      for (const changed of [
        { ...first, reason: 'A changed reason.' },
        { ...first, actingPrincipalId: alternatePrincipalId },
        {
          ...first,
          identityKey: {
            ...identityKey,
            commercialScope: { ...identityKey.commercialScope, channelId: 'B2B' as const },
          },
        },
        { ...first, monetaryAmount: { ...first.monetaryAmount, amount: '123.456789122' } },
      ]) {
        expect(yield* withPersistence(runtime, (persistence) => persistence.define(changed))).toEqual({
          outcome: 'CONFLICT',
          reason: 'IDEMPOTENCY_CONFLICT',
        });
      }
      expect(
        yield* withPersistence(runtime, (persistence) => persistence.readCurrent(priceRef(firstPriceId))),
      ).toMatchObject({
        definition: { priceRef: priceRef(firstPriceId) },
        outcome: 'PRICE_DEFINITION_CURRENT',
      });

      const freshReuse = command(concurrentInvocationId, concurrentPriceId);
      expect(yield* withPersistence(runtime, (persistence) => persistence.define(freshReuse))).toMatchObject({
        definition: { priceRef: priceRef(firstPriceId) },
        outcome: 'REUSED',
      });
      expect(yield* withPersistence(runtime, (persistence) => persistence.define(freshReuse))).toMatchObject({
        definition: { priceRef: priceRef(firstPriceId) },
        outcome: 'REUSED',
      });
      for (const changed of [
        { ...freshReuse, reason: 'Changed after exact-key reuse.' },
        { ...freshReuse, actingPrincipalId: alternatePrincipalId },
        {
          ...freshReuse,
          identityKey: {
            ...identityKey,
            commercialScope: { ...identityKey.commercialScope, marketId: 'sk-launch' },
          },
        },
        {
          ...freshReuse,
          identityKey: { ...identityKey, unitBasis: { ...identityKey.unitBasis, quantity: '2.000000000' } },
        },
        { ...freshReuse, priceRef: priceRef(alternatePriceId) },
        { ...freshReuse, monetaryAmount: { ...freshReuse.monetaryAmount, amount: '123.456789122' } },
        { ...freshReuse, effectiveFrom: '2026-09-27T09:59:59.000Z' },
      ]) {
        expect(yield* withPersistence(runtime, (persistence) => persistence.define(changed))).toEqual({
          outcome: 'CONFLICT',
          reason: 'IDEMPOTENCY_CONFLICT',
        });
      }

      yield* cleanup();
      const concurrentCommands = [
        command(firstInvocationId, firstPriceId),
        command(concurrentInvocationId, concurrentPriceId),
      ] as const;
      const concurrent = yield* Effect.all(
        concurrentCommands.map((candidate) => withPersistence(runtime, (persistence) => persistence.define(candidate))),
        { concurrency: 'unbounded' },
      );
      expect(concurrent.map(({ outcome }) => outcome).toSorted()).toEqual(['CREATED', 'REUSED']);
      const definitions = concurrent.flatMap((result) => ('definition' in result ? [result.definition] : []));
      expect(definitions).toHaveLength(2);
      expect(definitions[0]?.priceRef.resourceId).toBe(definitions[1]?.priceRef.resourceId);
      const loserIndex = concurrent.findIndex(({ outcome }) => outcome === 'REUSED');
      const loser = concurrentCommands[loserIndex];
      expect(loser).toBeDefined();
      if (loser === undefined) {
        return;
      }
      expect(yield* withPersistence(runtime, (persistence) => persistence.define(loser))).toMatchObject({
        outcome: 'REUSED',
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.define({ ...loser, reason: 'Adversarial concurrent-loser replay.' }),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'IDEMPOTENCY_CONFLICT' });
    }),
  ),
);

it.live('keeps every commercial Price dimension exact and never falls back across Market', () =>
  Effect.scoped(
    Effect.gen(function* exactCommercialPriceIdentity() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanupPricingFacts(admin);
      yield* Effect.addFinalizer(() => cleanupPricingFacts(admin).pipe(Effect.orDie));

      const exactCases: readonly {
        readonly actionInvocationId: string;
        readonly identity: PriceIdentityKey;
        readonly priceId: string;
      }[] = [
        {
          actionInvocationId: 'e7580000-0000-4000-8000-000000000001',
          identity: identityKey,
          priceId: 'e7580000-0000-4000-8000-000000000011',
        },
        {
          actionInvocationId: 'e7580000-0000-4000-8000-000000000002',
          identity: {
            ...identityKey,
            catalogSelection: {
              ...identityKey.catalogSelection,
              variantRef: {
                ...identityKey.catalogSelection.variantRef,
                resourceId: 'e7580000-0000-4000-8000-000000000021',
              },
            },
          },
          priceId: 'e7580000-0000-4000-8000-000000000012',
        },
        {
          actionInvocationId: 'e7580000-0000-4000-8000-000000000003',
          identity: {
            ...identityKey,
            commercialScope: { ...identityKey.commercialScope, channelId: 'B2B' as const },
          },
          priceId: 'e7580000-0000-4000-8000-000000000013',
        },
        {
          actionInvocationId: 'e7580000-0000-4000-8000-000000000004',
          identity: {
            ...identityKey,
            commercialScope: { ...identityKey.commercialScope, marketId: 'sk-launch' },
          },
          priceId: 'e7580000-0000-4000-8000-000000000014',
        },
        {
          actionInvocationId: 'e7580000-0000-4000-8000-000000000005',
          identity: { ...identityKey, currencyCode: 'EUR' },
          priceId: 'e7580000-0000-4000-8000-000000000015',
        },
        {
          actionInvocationId: 'e7580000-0000-4000-8000-000000000006',
          identity: {
            ...identityKey,
            unitBasis: { ...identityKey.unitBasis, quantity: '2.000000000' },
          },
          priceId: 'e7580000-0000-4000-8000-000000000016',
        },
        {
          actionInvocationId: 'e7580000-0000-4000-8000-000000000007',
          identity: {
            ...identityKey,
            unitBasis: {
              ...identityKey.unitBasis,
              unitRef: {
                ...identityKey.unitBasis.unitRef,
                resourceId: 'e7580000-0000-4000-8000-000000000022',
              },
            },
          },
          priceId: 'e7580000-0000-4000-8000-000000000017',
        },
        {
          actionInvocationId: 'e7580000-0000-4000-8000-000000000008',
          identity: {
            ...identityKey,
            priceGroupSelector: {
              kind: 'PRICE_GROUP',
              priceGroupRef: {
                moduleId: 'pricing.price-group-catalog',
                resourceId: 'e7580000-0000-4000-8000-000000000023',
                resourceType: 'pricing.price-group-catalog.price-group',
                tenantId,
              },
            },
          },
          priceId: 'e7580000-0000-4000-8000-000000000018',
        },
      ];

      for (const exactCase of exactCases) {
        const result = yield* withPersistence(runtime, (persistence) =>
          persistence.define(
            command(exactCase.actionInvocationId, exactCase.priceId, {
              identityKey: exactCase.identity,
              monetaryAmount: {
                amount: '123.456789123',
                currencyCode: exactCase.identity.currencyCode,
              },
            }),
          ),
        );
        expect(result).toMatchObject({
          definition: { identityKey: exactCase.identity, priceRef: priceRef(exactCase.priceId) },
          outcome: 'CREATED',
        });
        expect(
          yield* withPersistence(runtime, (persistence) => persistence.readCurrent(priceRef(exactCase.priceId))),
        ).toMatchObject({
          definition: { identityKey: exactCase.identity, priceRef: priceRef(exactCase.priceId) },
          outcome: 'PRICE_DEFINITION_CURRENT',
        });
      }

      const sameMarketProbe = yield* withPersistence(runtime, (persistence) =>
        persistence.define(command('e7580000-0000-4000-8000-000000000009', 'e7580000-0000-4000-8000-000000000019')),
      );
      expect(sameMarketProbe).toMatchObject({
        definition: { priceRef: priceRef('e7580000-0000-4000-8000-000000000011') },
        outcome: 'REUSED',
      });

      const missingMarketFailure = yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7580000-0000-4000-8000-00000000000a', 'e7580000-0000-4000-8000-00000000001a', {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: '' },
            },
          }),
        ),
      ).pipe(Effect.flip);
      expect(missingMarketFailure).toBeInstanceOf(PricePersistenceUnavailable);

      const otherTenantId = 'e7580000-0000-4000-8000-000000000024';
      const crossTenantFailure = yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7580000-0000-4000-8000-00000000000b', 'e7580000-0000-4000-8000-00000000001b', {
            identityKey: {
              ...identityKey,
              catalogSelection: {
                productRef: { ...identityKey.catalogSelection.productRef, tenantId: otherTenantId },
                variantRef: { ...identityKey.catalogSelection.variantRef, tenantId: otherTenantId },
              },
              unitBasis: {
                ...identityKey.unitBasis,
                unitRef: { ...identityKey.unitBasis.unitRef, tenantId: otherTenantId },
              },
            },
            priceRef: {
              ...priceRef('e7580000-0000-4000-8000-00000000001b'),
              tenantId: otherTenantId,
            },
          }),
        ),
      ).pipe(Effect.flip);
      expect(crossTenantFailure).toBeInstanceOf(PricePersistenceUnavailable);

      const crossSellerFailure = yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7580000-0000-4000-8000-00000000000c', 'e7580000-0000-4000-8000-00000000001c', {
            identityKey: {
              ...identityKey,
              commercialScope: {
                ...identityKey.commercialScope,
                sellingLegalEntityId: 'e7580000-0000-4000-8000-000000000025',
              },
            },
          }),
        ),
      ).pipe(Effect.flip);
      expect(crossSellerFailure).toBeInstanceOf(PricePersistenceUnavailable);
    }),
  ),
);

it.live('looks up one exact Current Price with authoritative absence and tenant Currency Support', () =>
  Effect.scoped(
    Effect.gen(function* exactCurrentPriceLookup() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const cleanup = () =>
        Effect.gen(function* cleanupExactLookupFacts() {
          yield* cleanupPricingFacts(admin);
          yield* cleanupExactLookupCurrencySupport(admin);
        });
      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* seedExactLookupCurrencySupport(admin);

      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.define(command('e7630000-0000-4000-8000-000000000010', firstPriceId)),
        ),
      ).toMatchObject({ outcome: 'CREATED' });

      const effectiveAt = yield* databaseCurrentInstant(admin);
      const evaluationTime = DateTime.makeUnsafe(effectiveAt);
      const found = yield* withPersistence(runtime, (persistence) =>
        persistence.exactLookup({ effectiveAt, exactKey: identityKey }),
      );
      const decodedFound = Schema.decodeUnknownOption(ExactPriceLookupFoundSchema)(found);
      expect(Option.isSome(decodedFound)).toBe(true);
      const foundValue = Option.getOrThrow(decodedFound);
      expect(foundValue).toMatchObject({
        priceRef: priceRef(firstPriceId),
        priceRevision: {
          monetaryAmount: { amount: '123.456789123', currencyCode: 'CZK' },
          monetaryBoundary: 'PRE_TAX',
        },
        request: { effectiveAt, exactKey: identityKey },
      });
      expect(foundValue.evidence.ownerRevision).toMatch(/^pricing-exact-current-v1:[0-9a-f]{64}$/u);

      for (const [amount, collisionRef] of [
        ['123.456789123', 'a'],
        ['999.000000000', 'b'],
      ] as const) {
        const collision = yield* runTestOnlyExactPriceCollisionFixture(admin, effectiveAt, amount, collisionRef);
        const decodedCollision = Schema.decodeOption(ExactPriceConflictDiagnosticSchema)(collision);
        expect(Option.isSome(decodedCollision)).toBe(true);
        const collisionValue = Option.getOrThrow(decodedCollision);
        expect(collisionValue.request).toEqual({ effectiveAt, exactKey: identityKey });
        expect(collisionValue.claimants.map(({ priceRef: claimantRef }) => claimantRef.resourceId)).toEqual(
          [firstPriceId, 'e7630000-0000-4000-8000-000000000020'].toSorted(),
        );
        expect(collisionValue.claimants.map(({ priceRevision }) => priceRevision.monetaryAmount.amount)).toContain(
          amount,
        );
      }

      const scheduled = yield* withPersistence(runtime, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7630000-0000-4000-8000-000000000011',
          effectivePeriod: {
            effectiveFrom: DateTime.formatIso(DateTime.add(evaluationTime, { hours: 1 })),
            effectiveTo: null,
          },
          expectedScheduleRevision: 1,
          intent: 'SCHEDULE_REVISION',
          monetaryAmount: { amount: '250', currencyCode: 'CZK' },
          priceRef: priceRef(firstPriceId),
          reason: 'Prove a future revision does not compete with Current exact lookup.',
          trustedOperationAt: DateTime.toDateUtc(evaluationTime),
        }),
      );
      expect(scheduled).toMatchObject({ outcome: 'REVISED' });
      const foundWithFuture = yield* withPersistence(runtime, (persistence) =>
        persistence.exactLookup({ effectiveAt, exactKey: identityKey }),
      );
      const decodedFoundWithFuture = Schema.decodeUnknownOption(ExactPriceLookupFoundSchema)(foundWithFuture);
      expect(Option.isSome(decodedFoundWithFuture)).toBe(true);
      const foundWithFutureValue = Option.getOrThrow(decodedFoundWithFuture);
      expect(foundWithFutureValue).toMatchObject({
        priceRef: priceRef(firstPriceId),
        priceRevision: { monetaryAmount: { amount: '123.456789123', currencyCode: 'CZK' } },
      });
      expect(foundWithFutureValue.evidence.ownerRevision).not.toBe(foundValue.evidence.ownerRevision);

      const otherMarket = {
        ...identityKey,
        commercialScope: { ...identityKey.commercialScope, marketId: 'sk-launch' },
      };
      const absent = yield* withPersistence(runtime, (persistence) =>
        persistence.exactLookup({ effectiveAt, exactKey: otherMarket }),
      );
      expect(Schema.is(ExactPriceLookupAbsentSchema)(absent)).toBe(true);
      if (!Schema.is(ExactPriceLookupAbsentSchema)(absent)) {
        throw new Error('Expected exact Market absence');
      }
      expect(absent.request).toEqual({ effectiveAt, exactKey: otherMarket });

      const unsupportedCurrency = { ...identityKey, currencyCode: 'EUR' };
      const invalid = yield* withPersistence(runtime, (persistence) =>
        persistence.exactLookup({ effectiveAt, exactKey: unsupportedCurrency }),
      );
      expect(Schema.is(ExactPriceLookupInvalidSchema)(invalid)).toBe(true);
      if (!Schema.is(ExactPriceLookupInvalidSchema)(invalid)) {
        throw new Error('Expected unsupported native-currency configuration');
      }
      expect(invalid).toMatchObject({
        reason: 'UNSUPPORTED_CURRENCY',
        request: { effectiveAt, exactKey: unsupportedCurrency },
      });
    }),
  ),
);

it.live('derives Current at explicit half-open boundaries and preserves futures through acknowledged edits', () =>
  Effect.scoped(
    Effect.gen(function* priceSchedulePersistenceAcceptance() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanPriceSchedules() {
            yield* transaction.execute(
              sql`delete from pricing.price_fee_action_result_receipts where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_fee_action_invocation_claims where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_source_assertion_deliveries where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_source_assertions where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_invocation_receipts where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_schedule_acknowledgements where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_schedule_heads where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_schedule_entries where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.price_schedule_revisions where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(sql`delete from pricing.price_revisions where tenant_id = ${tenantId}::uuid`);
            yield* transaction.execute(
              sql`delete from pricing.quantity_tier_set_heads where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.quantity_tier_set_revisions where tenant_id = ${tenantId}::uuid`,
            );
            yield* transaction.execute(
              sql`delete from pricing.quantity_tier_set_roots where tenant_id = ${tenantId}::uuid`,
            );
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
      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      yield* withPersistence(runtime, (persistence) => persistence.define(command(firstInvocationId, firstPriceId)));
      const ref = priceRef(firstPriceId);
      const initial = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(ref, instant('2026-09-27T11:00:00.000Z')),
      );
      if (initial.outcome !== 'PRICE_SCHEDULE_CURRENT' || initial.schedule.current === undefined) {
        return yield* Effect.die('Expected the zero-future initial Price Revision to be Current');
      }
      const zeroFutureCurrent = initial.schedule.current;
      const zeroFutureAcknowledgement = {
        actingPrincipalId: principalId,
        fingerprint: 'f'.repeat(64),
        intendedEffectivePeriod: { effectiveFrom: '2026-09-27T11:00:00.000Z', effectiveTo: null },
        intendedMonetaryAmount: { amount: '150.000000000', currencyCode: 'CZK' },
        intent: 'VALUE_ONLY_CURRENT' as const,
        presentedFuture: [],
        priceRef: ref,
        scheduleRevision: initial.schedule.scheduleRevision,
        targetRevisionId: zeroFutureCurrent.definition.revision.revisionId,
      };
      yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`insert into pricing.price_schedule_acknowledgements (
                tenant_id, legal_entity_id, price_id, fingerprint, acknowledgement, issued_by_principal_id
              ) values (
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${firstPriceId}::uuid,
                ${zeroFutureAcknowledgement.fingerprint}, ${JSON.stringify(zeroFutureAcknowledgement)}::jsonb,
                ${principalId}::uuid
              )`,
        ),
      );
      const zeroFutureEdit = (
        acknowledgement: typeof zeroFutureAcknowledgement,
      ): LegacyRevisePricePersistenceCommand => ({
        acknowledgement,
        actingPrincipalId: principalId,
        actionInvocationId: 'e7560000-0000-4000-8000-000000000007',
        expectedCurrent: {
          effectivePeriod: zeroFutureCurrent.effectivePeriod,
          priceRef: ref,
          revision: zeroFutureCurrent.definition.revision.revision,
          revisionId: zeroFutureCurrent.definition.revision.revisionId,
          scheduleRevision: initial.schedule.scheduleRevision,
        },
        intent: 'VALUE_ONLY_CURRENT',
        monetaryAmount: { amount: '150', currencyCode: 'CZK' },
        priceRef: ref,
        reason: 'Reject unauthenticated acknowledgement despite an empty future schedule.',
        trustedOperationAt: instant('2026-09-27T12:00:00.000Z'),
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise(zeroFutureEdit({ ...zeroFutureAcknowledgement, fingerprint: 'e'.repeat(64) })),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise(
            zeroFutureEdit({
              ...zeroFutureAcknowledgement,
              intendedMonetaryAmount: { amount: '151.000000000', currencyCode: 'CZK' },
            }),
          ),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' });

      const secondRef = priceRef(alternatePriceId);
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7560000-0000-4000-8000-000000000008', alternatePriceId, {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: 'cz-secondary' },
            },
          }),
        ),
      );
      const secondInitial = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(secondRef, instant('2026-09-27T12:00:00.000Z')),
      );
      if (secondInitial.outcome !== 'PRICE_SCHEDULE_CURRENT' || secondInitial.schedule.current === undefined) {
        return yield* Effect.die('Expected the second zero-future Price Revision to be Current');
      }
      const secondCurrent = secondInitial.schedule.current;
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            acknowledgement: zeroFutureAcknowledgement,
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000009',
            expectedCurrent: {
              effectivePeriod: secondCurrent.effectivePeriod,
              priceRef: secondRef,
              revision: secondCurrent.definition.revision.revision,
              revisionId: secondCurrent.definition.revision.revisionId,
              scheduleRevision: secondInitial.schedule.scheduleRevision,
            },
            intent: 'VALUE_ONLY_CURRENT',
            monetaryAmount: { amount: '150', currencyCode: 'CZK' },
            priceRef: secondRef,
            reason: 'Reject a cross-Price acknowledgement with an empty future schedule.',
            trustedOperationAt: instant('2026-09-27T12:00:00.000Z'),
          }),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(secondRef, instant('2026-09-27T12:00:00.000Z')),
        ),
      ).toMatchObject({ outcome: 'PRICE_SCHEDULE_CURRENT', schedule: { scheduleRevision: 1 } });

      const openEndedEdit: LegacyRevisePricePersistenceCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7560000-0000-4000-8000-00000000000c',
        expectedCurrent: {
          effectivePeriod: secondCurrent.effectivePeriod,
          priceRef: secondRef,
          revision: secondCurrent.definition.revision.revision,
          revisionId: secondCurrent.definition.revision.revisionId,
          scheduleRevision: secondInitial.schedule.scheduleRevision,
        },
        intent: 'VALUE_ONLY_CURRENT',
        monetaryAmount: { amount: '175', currencyCode: 'CZK' },
        priceRef: secondRef,
        reason: 'Keep a zero-future Price open after changing only its value.',
        trustedOperationAt: instant('2026-09-27T13:00:00.000Z'),
      };
      expect(yield* withPersistence(runtime, (persistence) => persistence.revise(openEndedEdit))).toMatchObject({
        outcome: 'REVISED',
        revision: { effectivePeriod: { effectiveFrom: '2026-09-27T13:00:00.000Z', effectiveTo: null } },
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(secondRef, instant('2026-10-01T00:00:00.000Z')),
        ),
      ).toMatchObject({
        outcome: 'PRICE_SCHEDULE_CURRENT',
        schedule: {
          current: {
            definition: { revision: { monetaryAmount: { amount: '175.000000000', currencyCode: 'CZK' } } },
            effectivePeriod: { effectiveTo: null },
          },
        },
      });

      const initialAtRetirement = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(ref, instant('2026-09-27T20:00:00.000Z')),
      );
      if (
        initialAtRetirement.outcome !== 'PRICE_SCHEDULE_CURRENT' ||
        initialAtRetirement.schedule.current === undefined
      ) {
        return yield* Effect.die('Expected the initial Price Revision to be Current');
      }
      const initialCurrent = initialAtRetirement.schedule.current;
      const retire: LegacyRevisePricePersistenceCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7560000-0000-4000-8000-000000000001',
        expectedCurrent: {
          effectivePeriod: initialCurrent.effectivePeriod,
          priceRef: ref,
          revision: initialCurrent.definition.revision.revision,
          revisionId: initialCurrent.definition.revision.revisionId,
          scheduleRevision: initialAtRetirement.schedule.scheduleRevision,
        },
        intent: 'RETIRE_CURRENT',
        priceRef: ref,
        reason: 'Retire the initial open Price period at an explicit boundary.',
        trustedOperationAt: instant('2026-09-27T20:00:00.000Z'),
      };
      expect(yield* withPersistence(runtime, (persistence) => persistence.revise(retire))).toMatchObject({
        outcome: 'REVISED',
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(ref, instant('2026-09-27T20:00:00.000Z')),
        ),
      ).toMatchObject({ outcome: 'PRICE_SCHEDULE_GAP' });

      const scheduleFuture: LegacyRevisePricePersistenceCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7560000-0000-4000-8000-000000000002',
        effectivePeriod: { effectiveFrom: '2026-09-27T20:00:00.000Z', effectiveTo: null },
        expectedScheduleRevision: 2,
        intent: 'SCHEDULE_REVISION',
        monetaryAmount: { amount: '200', currencyCode: 'CZK' },
        priceRef: ref,
        reason: 'Schedule the successor after the retained boundary.',
        trustedOperationAt: instant('2026-09-27T15:00:00.000Z'),
      };
      expect(yield* withPersistence(runtime, (persistence) => persistence.revise(scheduleFuture))).toMatchObject({
        outcome: 'REVISED',
      });

      const beforeBoundary = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(ref, instant('2026-09-27T15:00:00.000Z')),
      );
      if (beforeBoundary.outcome !== 'PRICE_SCHEDULE_CURRENT' || beforeBoundary.schedule.current === undefined) {
        return yield* Effect.die('Expected the finite pre-boundary Price Revision to be Current');
      }
      const { current } = beforeBoundary.schedule;
      const valueEdit: LegacyRevisePricePersistenceCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7560000-0000-4000-8000-000000000003',
        expectedCurrent: {
          effectivePeriod: current.effectivePeriod,
          priceRef: ref,
          revision: current.definition.revision.revision,
          revisionId: current.definition.revision.revisionId,
          scheduleRevision: beforeBoundary.schedule.scheduleRevision,
        },
        intent: 'VALUE_ONLY_CURRENT',
        monetaryAmount: { amount: '150', currencyCode: 'CZK' },
        priceRef: ref,
        reason: 'Change only the Current value while preserving its end and future.',
        trustedOperationAt: instant('2026-09-27T15:00:00.000Z'),
      };
      const warning = yield* withPersistence(runtime, (persistence) => persistence.revise(valueEdit));
      expect(warning).toMatchObject({ outcome: 'ACKNOWLEDGEMENT_REQUIRED' });
      if (warning.outcome !== 'ACKNOWLEDGEMENT_REQUIRED') {
        return yield* Effect.die('Expected a future-schedule acknowledgement challenge');
      }
      expect(
        yield* withPersistence(
          runtime,
          (persistence) =>
            persistence.revise({
              ...valueEdit,
              acknowledgement: warning.acknowledgement,
              actingPrincipalId: alternatePrincipalId,
              actionInvocationId: 'e7560000-0000-4000-8000-00000000000d',
              trustedOperationAt: instant('2026-09-27T16:00:00.000Z'),
            }),
          alternateScope,
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            ...valueEdit,
            acknowledgement: warning.acknowledgement,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000004',
            trustedOperationAt: instant('2026-09-27T20:00:00.000Z'),
          }),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            ...valueEdit,
            acknowledgement: warning.acknowledgement,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000005',
            trustedOperationAt: instant('2026-09-27T16:00:00.000Z'),
          }),
        ),
      ).toMatchObject({ outcome: 'REVISED' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            ...valueEdit,
            actionInvocationId: 'e7560000-0000-4000-8000-00000000000e',
            monetaryAmount: { amount: '150', currencyCode: 'CZK' },
            trustedOperationAt: instant('2026-09-27T17:00:00.000Z'),
          }),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'EXPECTED_CURRENT_MISMATCH' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            ...valueEdit,
            acknowledgement: warning.acknowledgement,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000006',
            trustedOperationAt: instant('2026-09-27T17:00:00.000Z'),
          }),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' });

      const valueIntervals = yield* admin.execute<{
        readonly amount: string;
        readonly effectiveFrom: string;
        readonly effectiveTo: null | string;
      }>(
        sql`select revision.amount::text as "amount",
                   to_char(entry.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveFrom",
                   case when entry.effective_to is null then null else
                     to_char(entry.effective_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end as "effectiveTo"
              from pricing.price_schedule_heads as head
              join pricing.price_schedule_entries as entry
                on entry.price_schedule_revision_id = head.price_schedule_revision_id
               and entry.tenant_id = head.tenant_id
               and entry.legal_entity_id = head.legal_entity_id
               and entry.price_id = head.price_id
              join pricing.price_revisions as revision
                on revision.price_revision_id = entry.price_revision_id
               and revision.tenant_id = entry.tenant_id
               and revision.legal_entity_id = entry.legal_entity_id
               and revision.price_id = entry.price_id
             where head.tenant_id = ${tenantId}::uuid
               and head.legal_entity_id = ${legalEntityId}::uuid
               and head.price_id = ${firstPriceId}::uuid
             order by entry.effective_from`,
        'objects',
      );
      expect(valueIntervals).toEqual([
        {
          amount: '123.456789123',
          effectiveFrom: '2026-09-27T10:00:00.000Z',
          effectiveTo: '2026-09-27T15:00:00.000Z',
        },
        {
          amount: '150.000000000',
          effectiveFrom: '2026-09-27T15:00:00.000Z',
          effectiveTo: '2026-09-27T20:00:00.000Z',
        },
        { amount: '200.000000000', effectiveFrom: '2026-09-27T20:00:00.000Z', effectiveTo: null },
      ]);

      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(ref, instant('2026-09-27T19:59:59.999Z')),
        ),
      ).toMatchObject({
        outcome: 'PRICE_SCHEDULE_CURRENT',
        schedule: {
          current: {
            definition: { revision: { monetaryAmount: { amount: '150.000000000', currencyCode: 'CZK' } } },
            effectivePeriod: { effectiveTo: '2026-09-27T20:00:00.000Z' },
          },
        },
      });
      const beforeRetirement = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(ref, instant('2026-09-27T17:00:00.000Z')),
      );
      if (beforeRetirement.outcome !== 'PRICE_SCHEDULE_CURRENT' || beforeRetirement.schedule.current === undefined) {
        return yield* Effect.die('Expected the acknowledged-retirement target to remain Current');
      }
      const retirementTarget = beforeRetirement.schedule.current;
      const acknowledgedRetirement: LegacyRevisePricePersistenceCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7560000-0000-4000-8000-00000000000a',
        expectedCurrent: {
          effectivePeriod: retirementTarget.effectivePeriod,
          priceRef: ref,
          revision: retirementTarget.definition.revision.revision,
          revisionId: retirementTarget.definition.revision.revisionId,
          scheduleRevision: beforeRetirement.schedule.scheduleRevision,
        },
        intent: 'RETIRE_CURRENT',
        priceRef: ref,
        reason: 'Retire at the challenged boundary, not the later redemption instant.',
        trustedOperationAt: instant('2026-09-27T17:00:00.000Z'),
      };
      const retirementWarning = yield* withPersistence(runtime, (persistence) =>
        persistence.revise(acknowledgedRetirement),
      );
      if (retirementWarning.outcome !== 'ACKNOWLEDGEMENT_REQUIRED') {
        return yield* Effect.die('Expected retirement to challenge the retained future schedule');
      }
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            ...acknowledgedRetirement,
            acknowledgement: retirementWarning.acknowledgement,
            actionInvocationId: 'e7560000-0000-4000-8000-00000000000b',
            trustedOperationAt: instant('2026-09-27T18:00:00.000Z'),
          }),
        ),
      ).toMatchObject({ outcome: 'REVISED' });
      const [retirementInterval] = yield* admin.execute<{
        readonly effectiveFrom: string;
        readonly effectiveTo: string;
      }>(
        sql`select to_char(entry.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveFrom",
                   to_char(entry.effective_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveTo"
              from pricing.price_schedule_heads as head
              join pricing.price_schedule_entries as entry
                on entry.price_schedule_revision_id = head.price_schedule_revision_id
               and entry.tenant_id = head.tenant_id
               and entry.legal_entity_id = head.legal_entity_id
               and entry.price_id = head.price_id
              join pricing.price_revisions as revision
                on revision.price_revision_id = entry.price_revision_id
               and revision.tenant_id = entry.tenant_id
               and revision.legal_entity_id = entry.legal_entity_id
               and revision.price_id = entry.price_id
             where head.tenant_id = ${tenantId}::uuid
               and head.legal_entity_id = ${legalEntityId}::uuid
               and head.price_id = ${firstPriceId}::uuid
               and revision.transition_kind = 'RETIREMENT'
             order by revision.revision_number desc
             limit 1`,
        'objects',
      );
      expect(retirementInterval).toEqual({
        effectiveFrom: '2026-09-27T15:00:00.000Z',
        effectiveTo: '2026-09-27T17:00:00.000Z',
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(ref, instant('2026-09-27T18:00:00.000Z')),
        ),
      ).toMatchObject({ outcome: 'PRICE_SCHEDULE_GAP' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(ref, instant('2026-09-27T20:00:00.000Z')),
        ),
      ).toMatchObject({
        outcome: 'PRICE_SCHEDULE_CURRENT',
        schedule: { current: { definition: { revision: { monetaryAmount: { amount: '200.000000000' } } } } },
      });
      return null;
    }),
  ),
);

it.live('splits an open-ended Price at a forward scheduled boundary and corrects only an exact Price Revision', () =>
  Effect.scoped(
    Effect.gen(function* scheduleAndCorrectPriceRevision() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanupPricingFacts(admin);
      yield* Effect.addFinalizer(() => cleanupPricingFacts(admin).pipe(Effect.orDie));

      const ref = priceRef(scheduledPriceId);
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7560000-0000-4000-8000-000000000030', scheduledPriceId, {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: 'scheduled-forward' },
            },
          }),
        ),
      );
      const initial = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(ref, instant('2026-09-27T12:00:00.000Z')),
      );
      if (initial.outcome !== 'PRICE_SCHEDULE_CURRENT' || initial.schedule.current === undefined) {
        return yield* Effect.die('Expected the normal defined Price to start open-ended');
      }
      const initialRevision = initial.schedule.current;
      const scheduled = yield* withPersistence(runtime, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7560000-0000-4000-8000-000000000031',
          effectivePeriod: { effectiveFrom: '2026-09-27T14:00:00.000Z', effectiveTo: null },
          expectedScheduleRevision: initial.schedule.scheduleRevision,
          intent: 'SCHEDULE_REVISION',
          monetaryAmount: { amount: '200', currencyCode: 'CZK' },
          priceRef: ref,
          reason: 'Schedule a real future Price value.',
          trustedOperationAt: instant('2026-09-27T12:00:00.000Z'),
        }),
      );
      expect(scheduled).toMatchObject({
        outcome: 'REVISED',
        provenance: {
          canonicalLink: { effectiveFrom: '2026-09-27T14:00:00.000Z' },
          evidence: {
            lineage: {
              actingPrincipalId: principalId,
              kind: 'SUPERSESSION',
              supersededSourceAssertionId: 'e7560000-0000-4000-8000-000000000030',
            },
          },
        },
        revision: {
          definition: { priceRef: ref, revision: { monetaryAmount: { amount: '200.000000000' } } },
          effectivePeriod: { effectiveFrom: '2026-09-27T14:00:00.000Z', effectiveTo: null },
        },
      });

      for (const [observedAt, amount, revisionId] of [
        ['2026-09-27T13:59:59.999Z', '123.456789123', initialRevision.definition.revision.revisionId],
        [
          '2026-09-27T14:00:00.000Z',
          '200.000000000',
          scheduled.outcome === 'REVISED' ? scheduled.revision.definition.revision.revisionId : '',
        ],
        [
          '2026-09-27T14:00:00.001Z',
          '200.000000000',
          scheduled.outcome === 'REVISED' ? scheduled.revision.definition.revision.revisionId : '',
        ],
      ] as const) {
        expect(
          yield* withPersistence(runtime, (persistence) => persistence.readSchedule(ref, instant(observedAt))),
        ).toMatchObject({
          outcome: 'PRICE_SCHEDULE_CURRENT',
          schedule: { current: { definition: { revision: { monetaryAmount: { amount }, revisionId } } } },
        });
      }

      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000032',
            effectivePeriod: {
              effectiveFrom: '2026-09-27T13:30:00.000Z',
              effectiveTo: '2026-09-27T15:00:00.000Z',
            },
            expectedScheduleRevision: 2,
            intent: 'SCHEDULE_REVISION',
            monetaryAmount: { amount: '175', currencyCode: 'CZK' },
            priceRef: ref,
            reason: 'Attempt a competing Current interval.',
            trustedOperationAt: instant('2026-09-27T12:30:00.000Z'),
          }),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'OVERLAPPING_SCHEDULE' });

      const otherRef = priceRef(finitePriceId);
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7560000-0000-4000-8000-000000000033', finitePriceId, {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: 'correction-control' },
            },
          }),
        ),
      );
      const other = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(otherRef, instant('2026-09-27T12:00:00.000Z')),
      );
      if (other.outcome !== 'PRICE_SCHEDULE_CURRENT' || other.schedule.current === undefined) {
        return yield* Effect.die('Expected the correction control Price to be Current');
      }
      const otherCurrent = other.schedule.current;
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000034',
            expectedScheduleRevision: 2,
            intent: 'CORRECT_REVISION',
            monetaryAmount: { amount: '110', currencyCode: 'CZK' },
            priceRef: ref,
            reason: 'Reject a Revision identifier owned by another Price.',
            targetRevisionId: otherCurrent.definition.revision.revisionId,
            trustedOperationAt: instant('2026-09-27T12:45:00.000Z'),
          }),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'TARGET_REVISION_NOT_FOUND' });

      const corrected = yield* withPersistence(runtime, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7560000-0000-4000-8000-000000000035',
          expectedScheduleRevision: 2,
          intent: 'CORRECT_REVISION',
          monetaryAmount: { amount: '110', currencyCode: 'CZK' },
          priceRef: ref,
          reason: 'Correct only the exact initial Revision value.',
          targetRevisionId: initialRevision.definition.revision.revisionId,
          trustedOperationAt: instant('2026-09-27T12:45:00.000Z'),
        }),
      );
      expect(corrected).toMatchObject({
        outcome: 'REVISED',
        provenance: {
          canonicalLink: { effectiveFrom: '2026-09-27T10:00:00.000Z' },
          evidence: {
            lineage: {
              actingPrincipalId: principalId,
              correctedSourceAssertionId: 'e7560000-0000-4000-8000-000000000030',
              kind: 'CORRECTION',
            },
          },
        },
        revision: {
          definition: { priceRef: ref, revision: { monetaryAmount: { amount: '110.000000000' } } },
          effectivePeriod: {
            effectiveFrom: '2026-09-27T10:00:00.000Z',
            effectiveTo: '2026-09-27T14:00:00.000Z',
          },
          lineage: { correctedRevisionId: initialRevision.definition.revision.revisionId, kind: 'CORRECTION' },
        },
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(ref, instant('2026-09-27T13:00:00.000Z')),
        ),
      ).toMatchObject({
        outcome: 'PRICE_SCHEDULE_CURRENT',
        schedule: {
          current: {
            definition: { priceRef: ref, revision: { monetaryAmount: { amount: '110.000000000' } } },
          },
          scheduleRevision: 3,
        },
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(ref, instant('2026-09-27T14:00:00.000Z')),
        ),
      ).toMatchObject({
        outcome: 'PRICE_SCHEDULE_CURRENT',
        schedule: {
          current: {
            definition: { priceRef: ref, revision: { monetaryAmount: { amount: '200.000000000' } } },
          },
          scheduleRevision: 3,
        },
      });
      return null;
    }),
  ),
);

it.live('creates a same-value Current successor at a distinct effective boundary and preserves gaps and futures', () =>
  Effect.scoped(
    Effect.gen(function* sameValuePriceSuccessor() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanupPricingFacts(admin);
      yield* Effect.addFinalizer(() => cleanupPricingFacts(admin).pipe(Effect.orDie));

      const sameValuePriceId = 'e7560000-0000-4000-8000-000000000060';
      const ref = priceRef(sameValuePriceId);
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7560000-0000-4000-8000-000000000061', sameValuePriceId, {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: 'same-value-successor' },
            },
          }),
        ),
      );
      const initial = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(ref, instant('2026-09-27T11:00:00.000Z')),
      );
      if (initial.outcome !== 'PRICE_SCHEDULE_CURRENT' || initial.schedule.current === undefined) {
        return yield* Effect.die('Expected the same-value successor Price to begin Current');
      }
      const initialCurrent = initial.schedule.current;

      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000062',
            expectedCurrent: {
              effectivePeriod: initialCurrent.effectivePeriod,
              priceRef: ref,
              revision: initialCurrent.definition.revision.revision,
              revisionId: initialCurrent.definition.revision.revisionId,
              scheduleRevision: initial.schedule.scheduleRevision,
            },
            intent: 'RETIRE_CURRENT',
            priceRef: ref,
            reason: 'Create the deliberate gap before the finite Price period.',
            trustedOperationAt: instant('2026-09-27T12:00:00.000Z'),
          }),
        ),
      ).toMatchObject({ outcome: 'REVISED' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000063',
            effectivePeriod: {
              effectiveFrom: '2026-09-27T14:00:00.000Z',
              effectiveTo: '2026-09-27T16:00:00.000Z',
            },
            expectedScheduleRevision: 2,
            intent: 'SCHEDULE_REVISION',
            monetaryAmount: { amount: '250', currencyCode: 'CZK' },
            priceRef: ref,
            reason: 'Create the finite Price period that will receive an immutable successor.',
            trustedOperationAt: instant('2026-09-27T13:00:00.000Z'),
          }),
        ),
      ).toMatchObject({ outcome: 'REVISED' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000064',
            effectivePeriod: { effectiveFrom: '2026-09-27T18:00:00.000Z', effectiveTo: null },
            expectedScheduleRevision: 3,
            intent: 'SCHEDULE_REVISION',
            monetaryAmount: { amount: '300', currencyCode: 'CZK' },
            priceRef: ref,
            reason: 'Retain a future Price after the deliberate second gap.',
            trustedOperationAt: instant('2026-09-27T13:30:00.000Z'),
          }),
        ),
      ).toMatchObject({ outcome: 'REVISED' });

      const beforeSuccessor = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(ref, instant('2026-09-27T14:30:00.000Z')),
      );
      if (beforeSuccessor.outcome !== 'PRICE_SCHEDULE_CURRENT' || beforeSuccessor.schedule.current === undefined) {
        return yield* Effect.die('Expected the finite Price period to be Current before its same-value successor');
      }
      const predecessor = beforeSuccessor.schedule.current;
      const sameValueCommand: LegacyRevisePricePersistenceCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7560000-0000-4000-8000-000000000065',
        expectedCurrent: {
          effectivePeriod: predecessor.effectivePeriod,
          priceRef: ref,
          revision: predecessor.definition.revision.revision,
          revisionId: predecessor.definition.revision.revisionId,
          scheduleRevision: beforeSuccessor.schedule.scheduleRevision,
        },
        intent: 'VALUE_ONLY_CURRENT',
        monetaryAmount: { amount: '250', currencyCode: 'CZK' },
        priceRef: ref,
        reason: 'Create an immutable successor at the explicit effective boundary despite an unchanged value.',
        trustedOperationAt: instant('2026-09-27T15:00:00.000Z'),
      };
      const warning = yield* withPersistence(runtime, (persistence) => persistence.revise(sameValueCommand));
      if (warning.outcome !== 'ACKNOWLEDGEMENT_REQUIRED') {
        return yield* Effect.die('Expected the future Price to require an explicit schedule acknowledgement');
      }
      expect(warning.acknowledgement.intendedEffectivePeriod).toEqual({
        effectiveFrom: '2026-09-27T15:00:00.000Z',
        effectiveTo: '2026-09-27T16:00:00.000Z',
      });

      const revised = yield* withPersistence(runtime, (persistence) =>
        persistence.revise({
          ...sameValueCommand,
          acknowledgement: warning.acknowledgement,
        }),
      );
      if (revised.outcome === 'CONFLICT') {
        return yield* Effect.die(`Expected same-value successor creation, received ${revised.reason}`);
      }
      expect(revised).toMatchObject({
        outcome: 'REVISED',
        revision: {
          definition: {
            revision: {
              effectiveFrom: '2026-09-27T15:00:00.000Z',
              monetaryAmount: { amount: '250.000000000', currencyCode: 'CZK' },
            },
          },
          effectivePeriod: {
            effectiveFrom: '2026-09-27T15:00:00.000Z',
            effectiveTo: '2026-09-27T16:00:00.000Z',
          },
          lineage: {
            kind: 'VALUE_ONLY_CURRENT',
            previousRevisionId: predecessor.definition.revision.revisionId,
          },
        },
      });
      if (revised.outcome !== 'REVISED') {
        return yield* Effect.die('Expected a same-value request at a new boundary to create a Revision');
      }
      expect(revised.revision.definition.revision.revisionId).not.toBe(predecessor.definition.revision.revisionId);

      for (const observedAt of [
        '2026-09-27T13:00:00.000Z',
        '2026-09-27T16:00:00.000Z',
        '2026-09-27T17:59:59.999Z',
      ] as const) {
        expect(
          yield* withPersistence(runtime, (persistence) => persistence.readSchedule(ref, instant(observedAt))),
        ).toMatchObject({ outcome: 'PRICE_SCHEDULE_GAP' });
      }
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(ref, instant('2026-09-27T14:59:59.999Z')),
        ),
      ).toMatchObject({
        outcome: 'PRICE_SCHEDULE_CURRENT',
        schedule: {
          current: { definition: { revision: { revisionId: predecessor.definition.revision.revisionId } } },
        },
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(ref, instant('2026-09-27T15:00:00.000Z')),
        ),
      ).toMatchObject({
        outcome: 'PRICE_SCHEDULE_CURRENT',
        schedule: {
          current: { definition: { revision: { revisionId: revised.revision.definition.revision.revisionId } } },
          scheduleRevision: 5,
        },
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(ref, instant('2026-09-27T18:00:00.000Z')),
        ),
      ).toMatchObject({
        outcome: 'PRICE_SCHEDULE_CURRENT',
        schedule: {
          current: { definition: { revision: { monetaryAmount: { amount: '300.000000000' } } } },
          scheduleRevision: 5,
        },
      });
      return null;
    }),
  ),
);

it.live('retains a deliberate gap around a finite scheduled Price interval', () =>
  Effect.scoped(
    Effect.gen(function* retainFiniteScheduleGap() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanupPricingFacts(admin);
      yield* Effect.addFinalizer(() => cleanupPricingFacts(admin).pipe(Effect.orDie));

      const ref = priceRef(finitePriceId);
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7560000-0000-4000-8000-000000000040', finitePriceId, {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: 'finite-gap' },
            },
          }),
        ),
      );
      const initial = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(ref, instant('2026-09-27T12:00:00.000Z')),
      );
      if (initial.outcome !== 'PRICE_SCHEDULE_CURRENT' || initial.schedule.current === undefined) {
        return yield* Effect.die('Expected the finite-gap Price to begin Current');
      }
      const initialCurrent = initial.schedule.current;
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000041',
            expectedCurrent: {
              effectivePeriod: initialCurrent.effectivePeriod,
              priceRef: ref,
              revision: initialCurrent.definition.revision.revision,
              revisionId: initialCurrent.definition.revision.revisionId,
              scheduleRevision: initial.schedule.scheduleRevision,
            },
            intent: 'RETIRE_CURRENT',
            priceRef: ref,
            reason: 'Retire before a deliberately retained gap.',
            trustedOperationAt: instant('2026-09-27T12:00:00.000Z'),
          }),
        ),
      ).toMatchObject({ outcome: 'REVISED' });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000042',
            effectivePeriod: {
              effectiveFrom: '2026-09-27T14:00:00.000Z',
              effectiveTo: '2026-09-27T16:00:00.000Z',
            },
            expectedScheduleRevision: 2,
            intent: 'SCHEDULE_REVISION',
            monetaryAmount: { amount: '250', currencyCode: 'CZK' },
            priceRef: ref,
            reason: 'Add a finite Price interval without filling either gap.',
            trustedOperationAt: instant('2026-09-27T13:00:00.000Z'),
          }),
        ),
      ).toMatchObject({
        outcome: 'REVISED',
        revision: {
          effectivePeriod: {
            effectiveFrom: '2026-09-27T14:00:00.000Z',
            effectiveTo: '2026-09-27T16:00:00.000Z',
          },
        },
      });

      for (const observedAt of ['2026-09-27T13:59:59.999Z', '2026-09-27T16:00:00.000Z'] as const) {
        expect(
          yield* withPersistence(runtime, (persistence) => persistence.readSchedule(ref, instant(observedAt))),
        ).toMatchObject({ outcome: 'PRICE_SCHEDULE_GAP' });
      }
      for (const observedAt of ['2026-09-27T14:00:00.000Z', '2026-09-27T15:59:59.999Z'] as const) {
        expect(
          yield* withPersistence(runtime, (persistence) => persistence.readSchedule(ref, instant(observedAt))),
        ).toMatchObject({
          outcome: 'PRICE_SCHEDULE_CURRENT',
          schedule: {
            current: {
              definition: { revision: { monetaryAmount: { amount: '250.000000000' } } },
              effectivePeriod: {
                effectiveFrom: '2026-09-27T14:00:00.000Z',
                effectiveTo: '2026-09-27T16:00:00.000Z',
              },
            },
          },
        });
      }
      return null;
    }),
  ),
);

it.live('serializes concurrent Current value edits and retirements with one typed stale loser', () =>
  Effect.scoped(
    Effect.gen(function* serializeCompetingCurrentChanges() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanupPricingFacts(admin);
      yield* Effect.addFinalizer(() => cleanupPricingFacts(admin).pipe(Effect.orDie));

      const editRef = priceRef(concurrentEditPriceId);
      const retirementRef = priceRef(concurrentRetirementPriceId);
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7560000-0000-4000-8000-000000000050', concurrentEditPriceId, {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: 'concurrent-edit' },
            },
          }),
        ),
      );
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7560000-0000-4000-8000-000000000051', concurrentRetirementPriceId, {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: 'concurrent-retirement' },
            },
          }),
        ),
      );

      const editInitial = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(editRef, instant('2026-09-27T12:00:00.000Z')),
      );
      const retirementInitial = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(retirementRef, instant('2026-09-27T12:00:00.000Z')),
      );
      if (
        editInitial.outcome !== 'PRICE_SCHEDULE_CURRENT' ||
        editInitial.schedule.current === undefined ||
        retirementInitial.outcome !== 'PRICE_SCHEDULE_CURRENT' ||
        retirementInitial.schedule.current === undefined
      ) {
        return yield* Effect.die('Expected both concurrency-control Prices to be Current');
      }
      const editExpected = {
        effectivePeriod: editInitial.schedule.current.effectivePeriod,
        priceRef: editRef,
        revision: editInitial.schedule.current.definition.revision.revision,
        revisionId: editInitial.schedule.current.definition.revision.revisionId,
        scheduleRevision: editInitial.schedule.scheduleRevision,
      };
      const editOutcomes = yield* Effect.forEach(
        [
          { actionInvocationId: 'e7560000-0000-4000-8000-000000000052', amount: '150' },
          { actionInvocationId: 'e7560000-0000-4000-8000-000000000053', amount: '175' },
        ],
        ({ actionInvocationId, amount }) =>
          withPersistence(runtime, (persistence) =>
            persistence.revise({
              actingPrincipalId: principalId,
              actionInvocationId,
              expectedCurrent: editExpected,
              intent: 'VALUE_ONLY_CURRENT',
              monetaryAmount: { amount, currencyCode: 'CZK' },
              priceRef: editRef,
              reason: 'Compete to change the same exact Current Price Revision.',
              trustedOperationAt: instant('2026-09-27T13:00:00.000Z'),
            }),
          ),

        { concurrency: 'unbounded' },
      );
      expect(editOutcomes.map(({ outcome }) => outcome).toSorted()).toEqual(['CONFLICT', 'REVISED']);
      expect(editOutcomes.filter(({ outcome }) => outcome === 'CONFLICT')).toEqual([
        { outcome: 'CONFLICT', reason: 'EXPECTED_CURRENT_MISMATCH' },
      ]);

      const retirementExpected = {
        effectivePeriod: retirementInitial.schedule.current.effectivePeriod,
        priceRef: retirementRef,
        revision: retirementInitial.schedule.current.definition.revision.revision,
        revisionId: retirementInitial.schedule.current.definition.revision.revisionId,
        scheduleRevision: retirementInitial.schedule.scheduleRevision,
      };
      const retirementOutcomes = yield* Effect.forEach(
        ['e7560000-0000-4000-8000-000000000054', 'e7560000-0000-4000-8000-000000000055'],
        (actionInvocationId) =>
          withPersistence(runtime, (persistence) =>
            persistence.revise({
              actingPrincipalId: principalId,
              actionInvocationId,
              expectedCurrent: retirementExpected,
              intent: 'RETIRE_CURRENT',
              priceRef: retirementRef,
              reason: 'Compete to end the same exact Current Price Revision.',
              trustedOperationAt: instant('2026-09-27T13:00:00.000Z'),
            }),
          ),

        { concurrency: 'unbounded' },
      );
      expect(retirementOutcomes.map(({ outcome }) => outcome).toSorted()).toEqual(['CONFLICT', 'REVISED']);
      expect(retirementOutcomes.filter(({ outcome }) => outcome === 'CONFLICT')).toEqual([
        { outcome: 'CONFLICT', reason: 'EXPECTED_CURRENT_MISMATCH' },
      ]);
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.readSchedule(retirementRef, instant('2026-09-27T13:00:00.000Z')),
        ),
      ).toMatchObject({ outcome: 'PRICE_SCHEDULE_GAP' });
      return null;
    }),
  ),
);

it.live('replaces exact-start Current intervals without a zero-length prefix and preserves each original end', () =>
  Effect.scoped(
    Effect.gen(function* replaceExactStartIntervals() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanupPricingFacts(admin);
      yield* Effect.addFinalizer(() => cleanupPricingFacts(admin).pipe(Effect.orDie));

      const openRef = priceRef(exactStartOpenPriceId);
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7560000-0000-4000-8000-000000000060', exactStartOpenPriceId, {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: 'exact-start-open' },
            },
          }),
        ),
      );
      const openInitial = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(openRef, instant('2026-09-27T10:00:00.000Z')),
      );
      if (openInitial.outcome !== 'PRICE_SCHEDULE_CURRENT' || openInitial.schedule.current === undefined) {
        return yield* Effect.die('Expected the open interval to be Current at its exact start');
      }
      const openCurrent = openInitial.schedule.current;
      const openReplacement = yield* withPersistence(runtime, (persistence) =>
        persistence.revise({
          actingPrincipalId: principalId,
          actionInvocationId: 'e7560000-0000-4000-8000-000000000061',
          expectedCurrent: {
            effectivePeriod: openCurrent.effectivePeriod,
            priceRef: openRef,
            revision: openCurrent.definition.revision.revision,
            revisionId: openCurrent.definition.revision.revisionId,
            scheduleRevision: openInitial.schedule.scheduleRevision,
          },
          intent: 'VALUE_ONLY_CURRENT',
          monetaryAmount: { amount: '300', currencyCode: 'CZK' },
          priceRef: openRef,
          reason: 'Replace the open interval at its exact effective start.',
          trustedOperationAt: instant('2026-09-27T10:00:00.000Z'),
        }),
      );
      expect(openReplacement).toMatchObject({
        outcome: 'REVISED',
        revision: {
          effectivePeriod: { effectiveFrom: '2026-09-27T10:00:00.000Z', effectiveTo: null },
        },
      });
      if (openReplacement.outcome !== 'REVISED') {
        return yield* Effect.die('Expected the exact-start open replacement to succeed');
      }
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000062',
            expectedCurrent: {
              effectivePeriod: openReplacement.revision.effectivePeriod,
              priceRef: openRef,
              revision: openReplacement.revision.definition.revision.revision,
              revisionId: openReplacement.revision.definition.revision.revisionId,
              scheduleRevision: 2,
            },
            intent: 'RETIRE_CURRENT',
            priceRef: openRef,
            reason: 'Reject retiring an interval at its own effective start.',
            trustedOperationAt: instant('2026-09-27T10:00:00.000Z'),
          }),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'BOUNDARY_CROSSED' });

      const finiteRef = priceRef(exactStartFinitePriceId);
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e7560000-0000-4000-8000-000000000063', exactStartFinitePriceId, {
            identityKey: {
              ...identityKey,
              commercialScope: { ...identityKey.commercialScope, marketId: 'exact-start-finite' },
            },
          }),
        ),
      );
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            actingPrincipalId: principalId,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000064',
            effectivePeriod: { effectiveFrom: '2026-09-27T14:00:00.000Z', effectiveTo: null },
            expectedScheduleRevision: 1,
            intent: 'SCHEDULE_REVISION',
            monetaryAmount: { amount: '400', currencyCode: 'CZK' },
            priceRef: finiteRef,
            reason: 'Create a finite Current interval for exact-start replacement.',
            trustedOperationAt: instant('2026-09-27T12:00:00.000Z'),
          }),
        ),
      ).toMatchObject({ outcome: 'REVISED' });
      const finiteInitial = yield* withPersistence(runtime, (persistence) =>
        persistence.readSchedule(finiteRef, instant('2026-09-27T10:00:00.000Z')),
      );
      if (finiteInitial.outcome !== 'PRICE_SCHEDULE_CURRENT' || finiteInitial.schedule.current === undefined) {
        return yield* Effect.die('Expected the finite interval to be Current at its exact start');
      }
      const finiteCurrent = finiteInitial.schedule.current;
      const finiteEdit: LegacyRevisePricePersistenceCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'e7560000-0000-4000-8000-000000000065',
        expectedCurrent: {
          effectivePeriod: finiteCurrent.effectivePeriod,
          priceRef: finiteRef,
          revision: finiteCurrent.definition.revision.revision,
          revisionId: finiteCurrent.definition.revision.revisionId,
          scheduleRevision: finiteInitial.schedule.scheduleRevision,
        },
        intent: 'VALUE_ONLY_CURRENT',
        monetaryAmount: { amount: '350', currencyCode: 'CZK' },
        priceRef: finiteRef,
        reason: 'Replace the finite interval at its exact effective start.',
        trustedOperationAt: instant('2026-09-27T10:00:00.000Z'),
      };
      const challenge = yield* withPersistence(runtime, (persistence) => persistence.revise(finiteEdit));
      if (challenge.outcome !== 'ACKNOWLEDGEMENT_REQUIRED') {
        return yield* Effect.die('Expected the exact-start finite replacement to acknowledge the future schedule');
      }
      expect(challenge.acknowledgement.intendedEffectivePeriod).toEqual({
        effectiveFrom: '2026-09-27T10:00:00.000Z',
        effectiveTo: '2026-09-27T14:00:00.000Z',
      });
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.revise({
            ...finiteEdit,
            acknowledgement: challenge.acknowledgement,
            actionInvocationId: 'e7560000-0000-4000-8000-000000000066',
            trustedOperationAt: instant('2026-09-27T11:00:00.000Z'),
          }),
        ),
      ).toMatchObject({
        outcome: 'REVISED',
        revision: {
          effectivePeriod: {
            effectiveFrom: '2026-09-27T10:00:00.000Z',
            effectiveTo: '2026-09-27T14:00:00.000Z',
          },
        },
      });

      const exactStartIntervals = yield* admin.execute<{
        readonly amount: string;
        readonly effectiveFrom: string;
        readonly effectiveTo: null | string;
        readonly priceId: string;
      }>(
        sql`select revision.amount::text as "amount",
                   to_char(entry.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveFrom",
                   case when entry.effective_to is null then null else
                     to_char(entry.effective_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end as "effectiveTo",
                   head.price_id::text as "priceId"
              from pricing.price_schedule_heads as head
              join pricing.price_schedule_entries as entry
                on entry.price_schedule_revision_id = head.price_schedule_revision_id
               and entry.tenant_id = head.tenant_id
               and entry.legal_entity_id = head.legal_entity_id
               and entry.price_id = head.price_id
              join pricing.price_revisions as revision
                on revision.price_revision_id = entry.price_revision_id
               and revision.tenant_id = entry.tenant_id
               and revision.legal_entity_id = entry.legal_entity_id
               and revision.price_id = entry.price_id
             where head.tenant_id = ${tenantId}::uuid
               and head.legal_entity_id = ${legalEntityId}::uuid
               and head.price_id in (${exactStartOpenPriceId}::uuid, ${exactStartFinitePriceId}::uuid)
             order by head.price_id, entry.effective_from`,
        'objects',
      );
      expect(exactStartIntervals).toEqual([
        {
          amount: '300.000000000',
          effectiveFrom: '2026-09-27T10:00:00.000Z',
          effectiveTo: null,
          priceId: exactStartOpenPriceId,
        },
        {
          amount: '350.000000000',
          effectiveFrom: '2026-09-27T10:00:00.000Z',
          effectiveTo: '2026-09-27T14:00:00.000Z',
          priceId: exactStartFinitePriceId,
        },
        {
          amount: '400.000000000',
          effectiveFrom: '2026-09-27T14:00:00.000Z',
          effectiveTo: null,
          priceId: exactStartFinitePriceId,
        },
      ]);
      return null;
    }),
  ),
);

it.live('reconciles mixed persisted Product targets and retries only the owner-proven absent target', () =>
  Effect.scoped(
    Effect.gen(function* productPriceBulkPersistenceRecovery() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanupPricingFacts(admin);
      yield* Effect.addFinalizer(() => cleanupPricingFacts(admin).pipe(Effect.orDie));

      const { productRef } = identityKey.catalogSelection;
      const variantRefs = [
        {
          ...identityKey.catalogSelection.variantRef,
          resourceId: 'e8070000-0000-4000-8000-000000000001',
        },
        {
          ...identityKey.catalogSelection.variantRef,
          resourceId: 'e8070000-0000-4000-8000-000000000002',
        },
        {
          ...identityKey.catalogSelection.variantRef,
          resourceId: 'e8070000-0000-4000-8000-000000000003',
        },
      ] as const;
      const snapshotId = 'pricing-recovery-807-fixed-snapshot';
      const capturedAt = '2026-09-27T10:00:00.000Z';
      const snapshot = yield* Schema.decodeEffect(PriceProductTargetSnapshotSchema)({
        capturedAt,
        catalogOwnerRevision: 'catalog-product-active-variants:recovery-807:v1',
        productRef,
        snapshotId,
        targets: variantRefs.map((variantRef, index) => ({
          catalogEvidence: {
            assessedAt: capturedAt,
            basis: [
              { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
              { role: 'VARIANT', source: { resourceRef: variantRef, revision: 1 } },
              {
                provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
                role: 'PRODUCT_TYPE_UNTYPED_DECISION',
                source: { resourceRef: productRef, revision: 1 },
              },
            ],
            membership: {
              attestationId: `catalog-membership:recovery-807:${index + 1}`,
              observedAt: capturedAt,
              productRef,
              source: 'CATALOG_OWNER_CURRENT_READ',
              variant: { resourceRef: variantRef, revision: 1 },
            },
            purpose: 'PRICING',
            selection: { productRef, variantRef },
            status: 'VALID',
          },
          target: { productRef, variantRef },
          targetId: `pricing-recovery-807-target-${index + 1}`,
        })),
        targetSetCompleteness: {
          observedAt: capturedAt,
          ownerRevision: 'catalog-product-active-variants:recovery-807:v1',
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-product:active-variants' },
        },
      });
      const intentIds = variantRefs.map((_, index) => `pricing-recovery-807-intent-${index + 1}`);
      const actionInvocationIds = intentIds.map((intentId) =>
        productPriceBulkActionInvocationIdFor(tenantId, intentId),
      );
      const priceIds = [
        'e8070000-0000-4000-8000-000000000010',
        'e8070000-0000-4000-8000-000000000011',
        'e8070000-0000-4000-8000-000000000012',
      ] as const;
      const operations = snapshot.targets.map((target, index) => {
        const actionInvocationId = actionInvocationIds[index];
        const priceId = priceIds[index];
        if (actionInvocationId === undefined || priceId === undefined) {
          throw new Error('Every fixed Product target requires one stable invocation and Price identity');
        }
        return command(actionInvocationId, priceId, {
          identityKey: {
            ...identityKey,
            catalogSelection: target.target,
          },
          monetaryAmount: { amount: `${101 + index}.000000000`, currencyCode: 'CZK' },
          reason: `Recover fixed Product target ${index + 1}.`,
        });
      });
      const intents = snapshot.targets.map(
        (target, index): ProductPriceBulkTargetIntent<DefinePricePersistenceCommand> => {
          const intentId = intentIds[index];
          const operation = operations[index];
          if (intentId === undefined || operation === undefined) {
            throw new Error('Every fixed Product target requires one stable intent and operation');
          }
          return {
            identity: { snapshotId: snapshot.snapshotId, target: target.target, targetId: target.targetId },
            intentId,
            operation,
            targetCorrelationRef: `pricing-recovery-807-correlation-${index + 1}`,
          };
        },
      );

      const [firstOperation, conflictOperation] = operations;
      if (firstOperation === undefined || conflictOperation === undefined) {
        throw new Error('The Product Price recovery fixture requires three fixed targets');
      }
      yield* withPersistence(runtime, (persistence) => persistence.define(firstOperation));
      yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          command('e8070000-0000-4000-8000-000000000020', 'e8070000-0000-4000-8000-000000000021', {
            identityKey: conflictOperation.identityKey,
            monetaryAmount: { amount: '999.000000000', currencyCode: 'CZK' },
            reason: 'Seed the canonical owner Price that the second fixed target conflicts with.',
          }),
        ),
      );

      const outcomeFromLookup = (
        result: Extract<PriceActionResultLookupOutcome, { readonly outcome: 'PRICE_ACTION_RESULT_FOUND' }>['result'],
      ): ProductPriceBulkOwnerOutcome => {
        if (result.outcome === 'CONFLICT') {
          return { outcome: 'CONFLICT', reasonCode: result.reason };
        }
        if (
          result.outcome === 'CREATED' ||
          result.outcome === 'REUSED' ||
          result.outcome === 'EFFECTIVE_TIME_INVALID'
        ) {
          return productPriceBulkOutcomeFromPersistence(result);
        }
        return { outcome: 'CONFLICT', reasonCode: 'UNEXPECTED_PRICE_ACTION_KIND' };
      };
      let thirdLookupUnavailable = true;
      const executed: string[] = [];
      const executeBulk = (persistence: TestPricePersistence) => {
        const port: ProductPriceBulkCommandPort<DefinePricePersistenceCommand> = {
          executeAuthorizedExactPriceAction: (bulkCommand) => {
            executed.push(bulkCommand.intentId);
            return persistence.define(bulkCommand.operation).pipe(
              Effect.map(productPriceBulkOutcomeFromPersistence),
              Effect.mapError((cause) => ({
                _tag: 'ProductPriceBulkPortFailure' as const,
                cause,
                code: 'PricePersistenceUnavailable',
              })),
            );
          },
          reconcileAuthorizedExactPriceAction: (bulkCommand) => {
            const invocationId = bulkCommand.operation.actionInvocationId;
            if (thirdLookupUnavailable && bulkCommand.intentId === intentIds[2]) {
              return Effect.fail({
                _tag: 'ProductPriceBulkPortFailure' as const,
                code: 'PriceOwnerResultLookupUnavailable',
              });
            }
            return persistence.lookupResult({ actionInvocationId: invocationId }).pipe(
              Effect.map((lookup) =>
                lookup.outcome === 'PRICE_ACTION_RESULT_ABSENT'
                  ? ({ status: 'RETRY_ALLOWED' as const } as const)
                  : ({ outcome: outcomeFromLookup(lookup.result), status: 'RESOLVED' as const } as const),
              ),
              Effect.mapError((cause) => ({
                _tag: 'ProductPriceBulkPortFailure' as const,
                cause,
                code: 'PriceOwnerResultLookupUnavailable',
              })),
            );
          },
        };
        return makeProductPriceBulkService(port).execute({
          snapshot,
          targetIntents: intents,
          trusted: {
            actionInvocationId: 'e8070000-0000-4000-8000-000000000030',
            compositionRevision: 'a'.repeat(64),
            principalContext: scope,
            requestCorrelationId: 'pricing-recovery-807',
            trustedOperationAt: instant('2026-09-27T10:00:01.000Z'),
          },
        });
      };

      const firstAttempt = yield* withPersistence(runtime, executeBulk);
      expect(firstAttempt.outcomes.map(({ outcome }) => outcome)).toEqual(['APPLIED', 'CONFLICT', 'INDETERMINATE']);
      expect(executed).toEqual([intentIds[1]]);

      thirdLookupUnavailable = false;
      const retry = yield* withPersistence(runtime, executeBulk);
      expect(retry.outcomes.map(({ outcome }) => outcome)).toEqual(['APPLIED', 'CONFLICT', 'APPLIED']);
      expect(executed).toEqual([intentIds[1], intentIds[2]]);
      expect(retry.outcomes.map(({ identity }) => identity.targetId)).toEqual(
        snapshot.targets.map(({ targetId }) => targetId),
      );

      const persistedPrices = yield* admin.execute<{ readonly count: number }>(
        sql`select count(*)::int as count from pricing.prices where tenant_id = ${tenantId}::uuid`,
        'objects',
      );
      expect(persistedPrices).toEqual([{ count: 3 }]);
    }),
  ),
);
