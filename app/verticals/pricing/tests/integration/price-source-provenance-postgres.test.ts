import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import type {
  PriceSourceAssertionInput,
  PriceSourceEvidence,
} from '@app/pricing-contracts/domain/price-source-provenance';
import type { PriceRef } from '@app/pricing-contracts/resources/price';
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
import type { DefinePricePersistenceCommand, PricePersistence } from '../../src/services/price-persistence.service.ts';
import { pricePersistenceForScope } from '../../src/services/price-persistence.service.ts';
import { preparePriceSourceEvidence } from '../../src/services/price-source-provenance.service.ts';

const tenantId = 'e7600000-0000-4000-8000-000000000001';
const legalEntityId = 'e7600000-0000-4000-8000-000000000002';
const principalId = 'e7600000-0000-4000-8000-000000000003';
const canonicalPriceId = 'e7600000-0000-4000-8000-000000000004';
const replayPriceId = 'e7600000-0000-4000-8000-000000000005';
const effectiveFrom = '2026-09-27T10:00:00.000Z';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];

const instant = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: 'e7600000-0000-4000-8000-000000000006',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const identityKey: PriceIdentityKey = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: 'e7600000-0000-4000-8000-000000000007',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: 'e7600000-0000-4000-8000-000000000008',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' },
  unitBasis: { quantity: '1.000000000', unitRef },
};
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'e7600000-0000-4000-8000-000000000009',
    authContextRef: 'session:price-source-provenance-postgres',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'price-source-provenance-postgres',
};

const priceRef = (resourceId: string): PriceRef => ({
  moduleId: 'commerce.pricing',
  resourceId,
  resourceType: 'commerce.pricing.price',
  tenantId,
});

const sourceAssertion = (input: {
  readonly importedAt: string;
  readonly sourceAssertionId: string;
  readonly sourceRecordVersion?: string;
}): PriceSourceAssertionInput =>
  Schema.decodeSync(PriceSourceAssertionInputSchema)({
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'erp-price-v2', mappingContractVersion: '2' },
    originalAssertion: {
      monetaryAmount: { amount: '100.000000000', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: { quantity: '1.000000000', unitRef },
    },
    sourceAssertionId: input.sourceAssertionId,
    sourceAuthority: { sourceAuthorityRef: 'pricing-owner', sourceAuthorityVersion: '7' },
    sourceRecord: {
      sourceChangeCorrelation: 'erp-change-84',
      sourceRecordRef: 'erp-price-row-42',
      sourceRecordVersion: input.sourceRecordVersion ?? '9',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
    },
    timing: {
      importedAt: input.importedAt,
      ownerBusinessEffectiveAt: effectiveFrom,
      sourceEffectiveAt: '2026-09-27T09:55:00.000Z',
    },
  });

const evidenceFor = (
  assertion: PriceSourceAssertionInput,
  recordedAt: string,
  assertedIdentityKey: PriceIdentityKey = identityKey,
): PriceSourceEvidence => {
  const prepared = preparePriceSourceEvidence({
    actingPrincipalId: principalId,
    effectiveFrom,
    identityKey: assertedIdentityKey,
    monetaryAmount: { amount: '100.000000000', currencyCode: 'CZK' },
    sourceAssertion: assertion,
    tenantId,
    trustedOperationAt: instant(recordedAt),
  });
  if (prepared.outcome !== 'READY_FOR_CANONICAL_WRITE') {
    throw new Error(`Expected ready source evidence, received ${prepared.outcome}`);
  }
  return prepared.evidence;
};

const defineCommand = (input: {
  readonly actionInvocationId: string;
  readonly evidence: PriceSourceEvidence;
  readonly identityKey?: PriceIdentityKey;
  readonly priceId: string;
  readonly requestCorrelationId: string;
}): DefinePricePersistenceCommand => ({
  actingPrincipalId: principalId,
  actionInvocationId: input.actionInvocationId,
  effectiveFrom,
  identityKey: input.identityKey ?? identityKey,
  monetaryAmount: { amount: '100.000000000', currencyCode: 'CZK' },
  priceRef: priceRef(input.priceId),
  reason: 'Record the exact owner-qualified source Price.',
  requestCorrelationId: input.requestCorrelationId,
  sourceEvidence: input.evidence,
  trustedOperationAt: instant(input.evidence.recordedAt),
});

const withPersistence = <Value, Failure>(
  database: PricingTestDatabase,
  operation: (persistence: PricePersistence) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PricingTransaction) =>
    Effect.gen(function* scopedPricePersistence() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
        'objects',
      );
      const ownerTransaction = yield* installOperationalScope(transaction, scope);
      const persistence = yield* pricePersistenceForScope(ownerTransaction, scope);
      return yield* operation(persistence);
    }),
  );

const cleanup = (admin: PricingTestDatabase) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupPriceSourceProvenance() {
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

it.live('binds one exact canonical revision to one stable owner fact and retains every delivery', () =>
  Effect.scoped(
    Effect.gen(function* stableSourceFactReplay() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const firstEvidence = evidenceFor(
        sourceAssertion({
          importedAt: '2026-09-27T10:01:00.000Z',
          sourceAssertionId: 'e7600000-0000-4000-8000-000000000010',
        }),
        '2026-09-27T10:02:00.000Z',
      );
      const laterDeliveryEvidence = evidenceFor(
        sourceAssertion({
          importedAt: '2026-09-28T10:01:00.000Z',
          sourceAssertionId: 'e7600000-0000-4000-8000-000000000011',
        }),
        '2026-09-28T10:02:00.000Z',
      );
      expect(laterDeliveryEvidence.sourceFactFingerprint).toBe(firstEvidence.sourceFactFingerprint);

      const created = yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          defineCommand({
            actionInvocationId: 'e7600000-0000-4000-8000-000000000012',
            evidence: firstEvidence,
            priceId: canonicalPriceId,
            requestCorrelationId: 'price-source:first-delivery',
          }),
        ),
      );
      const replayed = yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          defineCommand({
            actionInvocationId: 'e7600000-0000-4000-8000-000000000013',
            evidence: laterDeliveryEvidence,
            priceId: replayPriceId,
            requestCorrelationId: 'price-source:later-delivery',
          }),
        ),
      );

      expect(created).toMatchObject({ outcome: 'CREATED' });
      expect(replayed).toMatchObject({ outcome: 'REUSED' });
      if (!('provenance' in created) || !('provenance' in replayed)) {
        return yield* Effect.die('Expected canonical source provenance');
      }
      expect(replayed.definition.priceRef).toEqual(created.definition.priceRef);
      expect(replayed.definition.revision.revisionId).toBe(created.definition.revision.revisionId);
      expect(replayed.provenance.provenanceRef).toBe(created.provenance.provenanceRef);
      expect(created.provenance.canonicalLink.revisionId).toBe(created.definition.revision.revisionId);
      expect(created.provenance.canonicalLink.effectiveFrom).toBe(effectiveFrom);
      expect(created.provenance.canonicalLink.identityKey).toEqual(identityKey);
      const serializedProvenance = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        created.provenance,
      );
      expect(serializedProvenance).not.toContain('storefront');

      const counts = yield* admin.execute<{
        readonly deliveryCount: number;
        readonly priceRevisionCount: number;
        readonly provenanceCount: number;
      }>(
        sql`select
              (select count(*)::integer from pricing.price_source_assertion_deliveries
                where tenant_id = ${tenantId}::uuid) as "deliveryCount",
              (select count(*)::integer from pricing.price_revisions
                where tenant_id = ${tenantId}::uuid and price_id = ${canonicalPriceId}::uuid) as "priceRevisionCount",
              (select count(*)::integer from pricing.price_source_assertions
                where tenant_id = ${tenantId}::uuid) as "provenanceCount"`,
        'objects',
      );
      expect(counts).toEqual([{ deliveryCount: 2, priceRevisionCount: 1, provenanceCount: 1 }]);

      const deliveries = yield* admin.execute<{
        readonly deliveredSourceAssertionId: string;
        readonly importedAt: Date;
        readonly recordedAt: Date;
      }>(
        sql`select delivered_source_assertion_id as "deliveredSourceAssertionId",
                   imported_at as "importedAt", recorded_at as "recordedAt"
              from pricing.price_source_assertion_deliveries
             where tenant_id = ${tenantId}::uuid
             order by imported_at`,
        'objects',
      );
      expect(deliveries.map(({ deliveredSourceAssertionId }) => deliveredSourceAssertionId)).toEqual([
        'e7600000-0000-4000-8000-000000000010',
        'e7600000-0000-4000-8000-000000000011',
      ]);
      expect(deliveries[0]?.importedAt).not.toEqual(deliveries[1]?.importedAt);
      expect(deliveries[0]?.recordedAt).not.toEqual(deliveries[1]?.recordedAt);

      const competingEvidence = evidenceFor(
        sourceAssertion({
          importedAt: '2026-09-29T10:01:00.000Z',
          sourceAssertionId: 'e7600000-0000-4000-8000-000000000014',
          sourceRecordVersion: '10',
        }),
        '2026-09-29T10:02:00.000Z',
      );
      expect(competingEvidence.sourceFactFingerprint).not.toBe(firstEvidence.sourceFactFingerprint);
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.define(
            defineCommand({
              actionInvocationId: 'e7600000-0000-4000-8000-000000000015',
              evidence: competingEvidence,
              priceId: replayPriceId,
              requestCorrelationId: 'price-source:competing-fact',
            }),
          ),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'SOURCE_FACT_CONFLICT' });

      const nestedStorefrontEvidence = {
        ...firstEvidence,
        sourceAssertion: {
          ...firstEvidence.sourceAssertion,
          originalAssertion: {
            ...firstEvidence.sourceAssertion.originalAssertion,
            storefrontId: 'legacy-web-cz',
          },
        },
      };
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.define(
            defineCommand({
              actionInvocationId: 'e7600000-0000-4000-8000-000000000016',
              evidence: nestedStorefrontEvidence,
              priceId: replayPriceId,
              requestCorrelationId: 'price-source:nested-storefront-rejected',
            }),
          ),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'SOURCE_PROVENANCE_INVALID' });

      const afterConflict = yield* admin.execute<{
        readonly deliveryCount: number;
        readonly provenanceCount: number;
      }>(
        sql`select
              (select count(*)::integer from pricing.price_source_assertion_deliveries
                where tenant_id = ${tenantId}::uuid) as "deliveryCount",
              (select count(*)::integer from pricing.price_source_assertions
                where tenant_id = ${tenantId}::uuid) as "provenanceCount"`,
        'objects',
      );
      expect(afterConflict).toEqual([{ deliveryCount: 2, provenanceCount: 1 }]);
      return null;
    }),
  ),
);

it.live('links an identity-changing source correction from the old exact Price to its replacement', () =>
  Effect.scoped(
    Effect.gen(function* identityChangingCorrection() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* cleanup(admin);
      yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));

      const originalSourceAssertionId = 'e7600000-0000-4000-8000-000000000020';
      const originalEvidence = evidenceFor(
        sourceAssertion({
          importedAt: '2026-09-27T10:01:00.000Z',
          sourceAssertionId: originalSourceAssertionId,
        }),
        '2026-09-27T10:02:00.000Z',
      );
      const original = yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          defineCommand({
            actionInvocationId: 'e7600000-0000-4000-8000-000000000021',
            evidence: originalEvidence,
            priceId: canonicalPriceId,
            requestCorrelationId: 'price-source:identity-correction:original',
          }),
        ),
      );
      expect(original).toMatchObject({ outcome: 'CREATED' });

      const replacementPriceId = 'e7600000-0000-4000-8000-000000000022';
      const replacementIdentityKey: PriceIdentityKey = {
        ...identityKey,
        catalogSelection: {
          ...identityKey.catalogSelection,
          variantRef: {
            ...identityKey.catalogSelection.variantRef,
            resourceId: 'e7600000-0000-4000-8000-000000000023',
          },
        },
      };
      const unknownPredecessorAssertion = yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
        ...sourceAssertion({
          importedAt: '2026-09-27T10:03:00.000Z',
          sourceAssertionId: 'e7600000-0000-4000-8000-000000000026',
          sourceRecordVersion: '11',
        }),
        lineage: {
          correctedSourceAssertionId: 'e7600000-0000-4000-8000-000000000027',
          kind: 'CORRECTION',
          reason: 'An unknown predecessor must not establish replacement lineage.',
        },
      });
      const unknownPredecessorEvidence = evidenceFor(
        unknownPredecessorAssertion,
        '2026-09-27T10:03:30.000Z',
        replacementIdentityKey,
      );
      expect(
        yield* withPersistence(runtime, (persistence) =>
          persistence.define(
            defineCommand({
              actionInvocationId: 'e7600000-0000-4000-8000-000000000028',
              evidence: unknownPredecessorEvidence,
              identityKey: replacementIdentityKey,
              priceId: replacementPriceId,
              requestCorrelationId: 'price-source:identity-correction:unknown-predecessor',
            }),
          ),
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'SOURCE_LINEAGE_INVALID' });

      const correctionAssertion = yield* Schema.decodeEffect(PriceSourceAssertionInputSchema)({
        ...sourceAssertion({
          importedAt: '2026-09-27T10:04:00.000Z',
          sourceAssertionId: 'e7600000-0000-4000-8000-000000000024',
          sourceRecordVersion: '10',
        }),
        lineage: {
          correctedSourceAssertionId: originalSourceAssertionId,
          kind: 'CORRECTION',
          reason: 'Correct the owner mapping from the old Variant key to the replacement Variant key.',
        },
      });
      const correctionEvidence = evidenceFor(correctionAssertion, '2026-09-27T10:05:00.000Z', replacementIdentityKey);
      const replacement = yield* withPersistence(runtime, (persistence) =>
        persistence.define(
          defineCommand({
            actionInvocationId: 'e7600000-0000-4000-8000-000000000025',
            evidence: correctionEvidence,
            identityKey: replacementIdentityKey,
            priceId: replacementPriceId,
            requestCorrelationId: 'price-source:identity-correction:replacement',
          }),
        ),
      );

      expect(replacement).toMatchObject({ outcome: 'CREATED' });
      if (!('provenance' in original) || !('provenance' in replacement)) {
        return yield* Effect.die('Expected source provenance for both canonical Price identities');
      }
      expect(replacement.definition.priceRef.resourceId).toBe(replacementPriceId);
      expect(replacement.definition.identityKey).toEqual(replacementIdentityKey);
      expect(replacement.provenance.evidence.lineage).toMatchObject({
        actingPrincipalId: principalId,
        correctedSourceAssertionId: originalSourceAssertionId,
        kind: 'CORRECTION',
      });

      const lineage = yield* admin.execute<{
        readonly correctedSourceAssertionId: null | string;
        readonly priceId: string;
        readonly priceRevisionId: string;
        readonly sourceAssertionId: string;
      }>(
        sql`select source_assertion_id as "sourceAssertionId",
                   price_id as "priceId",
                   price_revision_id as "priceRevisionId",
                   corrected_source_assertion_id as "correctedSourceAssertionId"
              from pricing.price_source_assertions
             where tenant_id = ${tenantId}::uuid
             order by recorded_at`,
        'objects',
      );
      expect(lineage).toEqual([
        {
          correctedSourceAssertionId: null,
          priceId: canonicalPriceId,
          priceRevisionId: original.definition.revision.revisionId,
          sourceAssertionId: originalSourceAssertionId,
        },
        {
          correctedSourceAssertionId: originalSourceAssertionId,
          priceId: replacementPriceId,
          priceRevisionId: replacement.definition.revision.revisionId,
          sourceAssertionId: correctionAssertion.sourceAssertionId,
        },
      ]);
      expect(replacement.provenance.canonicalLink.priceRef.resourceId).toBe(replacementPriceId);
      expect(original.provenance.canonicalLink.priceRef.resourceId).toBe(canonicalPriceId);
      return null;
    }),
  ),
);
