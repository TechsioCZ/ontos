import { CatalogSelectionOwnerAssessmentResultSchema } from '@app/catalog/domain/catalog-selection-owner-contract';
import type { CatalogSelectionOwnerAssessmentResult } from '@app/catalog/domain/catalog-selection-owner-contract';
import { PriceSourceProvenanceSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  DefinePricePayloadSchema,
  DefinePriceRejected,
  applyPriceDefinition,
} from '../../src/actions/define-price.action.ts';
import type { DefinePriceActionServices } from '../../src/actions/define-price.action.ts';
import type { CommercialContextAssessment } from '../../src/integrations/commercial-context-evidence.ts';
import { PricePersistenceUnavailable } from '../../src/services/price-persistence.service.ts';
import { PricingCommercialContextUnavailable } from '../../shared/domain/commercial-context-gateway-credential.ts';
import {
  preparePriceSourceEvidence,
  priceSourceFactFingerprint,
} from '../../src/services/price-source-provenance.service.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const legalEntityId = '33333333-3333-4333-8333-333333333333';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const identityKey = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.product' as const,
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'commerce.catalog.variant' as const,
      tenantId,
    },
  },
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '77777777-7777-4777-8777-777777777777',
      resourceType: 'commerce.catalog.product-unit' as const,
      tenantId,
    },
  },
} as const;
const payload = Schema.decodeSync(DefinePricePayloadSchema)({
  effectiveFrom: '2026-09-27T10:00:00.000Z',
  identityKey,
  monetaryAmount: { amount: '0', currencyCode: 'CZK' },
  priceRef,
  reason: 'Define launch Price',
  sourceAssertion: {
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'erp-price-v2', mappingContractVersion: '2' },
    originalAssertion: {
      monetaryAmount: { amount: '0', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: identityKey.unitBasis,
    },
    sourceAssertionId: '11111111-1111-4111-8111-111111111111',
    sourceAuthority: { sourceAuthorityRef: 'pricing-owner', sourceAuthorityVersion: '7' },
    sourceRecord: {
      sourceChangeCorrelation: 'change-84',
      sourceRecordRef: 'price-row-42',
      sourceRecordVersion: '9',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
    },
    timing: {
      importedAt: '2026-09-27T10:00:00.500Z',
      ownerBusinessEffectiveAt: '2026-09-27T10:00:00.000Z',
      sourceEffectiveAt: '2026-09-27T09:59:00.000Z',
    },
  },
});
const trusted = {
  actingPrincipalId: '88888888-8888-4888-8888-888888888888',
  actionInvocationId: '99999999-9999-4999-8999-999999999999',
  legalEntityId,
  requestCorrelationId: 'define-price-unit',
  tenantId,
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T10:00:01.000Z')),
} as const;
const definition = {
  identityKey: payload.identityKey,
  priceRef,
  revision: {
    effectiveFrom: payload.effectiveFrom,
    monetaryAmount: payload.monetaryAmount,
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 1,
    revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
};
const provenance = Schema.decodeSync(PriceSourceProvenanceSchema)({
  canonicalLink: {
    effectiveFrom: definition.revision.effectiveFrom,
    identityKey: definition.identityKey,
    monetaryAmount: definition.revision.monetaryAmount,
    monetaryBoundary: 'PRE_TAX',
    priceRef,
    revision: 1,
    revisionId: definition.revision.revisionId,
  },
  evidence: {
    lineage: { kind: 'INITIAL' },
    recordedAt: '2026-09-27T10:00:01.000Z',
    sourceAssertion: payload.sourceAssertion,
    sourceFactFingerprint: priceSourceFactFingerprint(payload.sourceAssertion),
    tenantId,
  },
  provenanceRef: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
});
const persistenceSuccess = (outcome: 'CREATED' | 'REUSED') => ({ definition, outcome, provenance });
const assessedAt = '2026-09-27T10:00:00.000Z';
const validCatalogAssessment = Schema.decodeSync(CatalogSelectionOwnerAssessmentResultSchema)({
  assessedAt,
  basis: [
    { role: 'PRODUCT', source: { resourceRef: payload.identityKey.catalogSelection.productRef, revision: 1 } },
    { role: 'VARIANT', source: { resourceRef: payload.identityKey.catalogSelection.variantRef, revision: 1 } },
    {
      role: 'PRODUCT_TYPE',
      source: {
        resourceRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          resourceType: 'commerce.catalog.product-type',
          tenantId,
        },
        revision: 1,
      },
    },
  ],
  membership: {
    attestationId: 'catalog-membership-v1',
    observedAt: assessedAt,
    productRef: payload.identityKey.catalogSelection.productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: { resourceRef: payload.identityKey.catalogSelection.variantRef, revision: 1 },
  },
  purpose: 'PRICING',
  selection: payload.identityKey.catalogSelection,
  status: 'VALID',
});
const validCatalogBasis = 'status' in validCatalogAssessment ? validCatalogAssessment.basis : [];
const validCommercialContextAssessment = {
  commercialScope: payload.identityKey.commercialScope,
  completenessEvidence: {
    observedAt: DateTime.makeUnsafe(assessedAt),
    ownerRevision: 'commerce.market-catalog.current:v1:generation:7',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'tenant-seller-current-markets' },
  },
  marketDefinitionRevisionRef: {
    moduleId: 'commerce.market-catalog' as const,
    resourceId: 'market-revision-7',
    resourceType: 'commerce.market-catalog.market-definition-revision' as const,
    tenantId,
  },
  observedAt: DateTime.makeUnsafe(assessedAt),
  status: 'VALID' as const,
};
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '12111111-1111-4111-8111-111111111111',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '13111111-1111-4111-8111-111111111111',
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
};
const currentCurrencySupport = {
  currentnessEvidence: {
    evaluatedAt: payload.effectiveFrom,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: payload.effectiveFrom,
    revalidatedAt: payload.effectiveFrom,
    scheduleRevision: 1,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  generation: 1,
  observedAt: payload.effectiveFrom,
  pricingRevision: 'pricing-currency-support:1',
  scheduleRevision: 1,
  supportedCurrencies: ['CZK'] as const,
  supportRevisionRef,
  supportRootRef,
};

const servicesFor = (
  define: DefinePriceActionServices['define'],
  assessment: CatalogSelectionOwnerAssessmentResult = validCatalogAssessment,
  commercialContextAssessment: CommercialContextAssessment = validCommercialContextAssessment,
): DefinePriceActionServices => ({
  assessCatalogSelection: () => Effect.succeed(assessment),
  assessCommercialContext: () => Effect.succeed(commercialContextAssessment),
  assessExternalPriceInput: (request) => Effect.succeed(preparePriceSourceEvidence(request)),
  define,
  loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: currentCurrencySupport }),
});

describe('Define Price Action', () => {
  it.effect('creates and idempotently reuses one explicit zero Price fact', () =>
    Effect.gen(function* defineZeroPrice() {
      const created = yield* applyPriceDefinition(
        payload,
        trusted,
        servicesFor(() => Effect.succeed(persistenceSuccess('CREATED'))),
      );
      const reused = yield* applyPriceDefinition(
        payload,
        trusted,
        servicesFor(() => Effect.succeed(persistenceSuccess('REUSED'))),
      );
      expect(created).toEqual({ outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED', provenance });
      expect(reused).toEqual({ outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED', provenance });
    }),
  );

  it.effect('fails closed on rejected, unresolved, or unavailable source authority before persistence', () =>
    Effect.gen(function* rejectUnprovenSourceAuthority() {
      const assessments = [
        {
          outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
          reason: 'SOURCE_AUTHORITY_REJECTED',
          sourceAssertionId: payload.sourceAssertion.sourceAssertionId,
        },
        {
          outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
          reason: 'SOURCE_AUTHORITY_UNRESOLVED',
          sourceAssertionId: payload.sourceAssertion.sourceAssertionId,
        },
        {
          dependency: 'SOURCE_AUTHORITY',
          outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
          retryable: true,
          sourceAssertionId: payload.sourceAssertion.sourceAssertionId,
        },
      ] as const;
      const requests: unknown[] = [];
      const outcomes: unknown[] = [];
      let persistenceCalls = 0;
      const define: DefinePriceActionServices['define'] = () => {
        persistenceCalls += 1;
        return Effect.succeed(persistenceSuccess('CREATED'));
      };

      for (const assessment of assessments) {
        outcomes.push(
          yield* applyPriceDefinition(payload, trusted, {
            ...servicesFor(define),
            assessExternalPriceInput: (request) => {
              requests.push(request);
              return Effect.succeed(assessment);
            },
          }),
        );
      }

      const expectedRequest = {
        actingPrincipalId: trusted.actingPrincipalId,
        effectiveFrom: payload.effectiveFrom,
        identityKey: payload.identityKey,
        monetaryAmount: payload.monetaryAmount,
        sourceAssertion: payload.sourceAssertion,
        tenantId: trusted.tenantId,
        trustedOperationAt: trusted.trustedOperationAt,
      };
      expect(outcomes).toEqual(assessments);
      expect(requests).toEqual(assessments.map(() => expectedRequest));
      expect(persistenceCalls).toBe(0);
    }),
  );

  it.effect('fails closed before persistence on Tenant or Selling Legal Entity mismatch', () =>
    Effect.gen(function* rejectScopeMismatch() {
      const tenantExit = yield* Effect.exit(
        applyPriceDefinition(
          payload,
          { ...trusted, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          servicesFor(() => Effect.die('must not persist')),
        ),
      );
      const legalEntityExit = yield* Effect.exit(
        applyPriceDefinition(
          payload,
          { ...trusted, legalEntityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
          servicesFor(() => Effect.die('must not persist')),
        ),
      );
      expect(tenantExit.toString()).toContain(DefinePriceRejected.name);
      expect(legalEntityExit.toString()).toContain(DefinePriceRejected.name);
    }),
  );

  it.effect('fails closed before persistence for invalid or indeterminate Catalog assessments', () =>
    Effect.gen(function* rejectUnprovenCatalogTargets() {
      let persistenceCalls = 0;
      const define: DefinePriceActionServices['define'] = () => {
        persistenceCalls += 1;
        return Effect.succeed(persistenceSuccess('CREATED'));
      };
      const invalid = yield* Schema.decodeEffect(CatalogSelectionOwnerAssessmentResultSchema)({
        assessedAt,
        basis: validCatalogBasis,
        purpose: 'PRICING',
        reason: 'Variant does not belong to the selected Product',
        selection: payload.identityKey.catalogSelection,
        status: 'INVALID',
      });
      const indeterminate = yield* Schema.decodeEffect(CatalogSelectionOwnerAssessmentResultSchema)({
        assessedAt,
        basis: validCatalogBasis,
        purpose: 'PRICING',
        reason: 'Exact package or configuration evidence is incomplete',
        selection: payload.identityKey.catalogSelection,
        status: 'INDETERMINATE',
      });

      const invalidFailure = yield* applyPriceDefinition(payload, trusted, servicesFor(define, invalid));
      const indeterminateFailure = yield* applyPriceDefinition(payload, trusted, servicesFor(define, indeterminate));

      expect(invalidFailure).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
        reason: 'VARIANT_AMBIGUOUS',
      });
      expect(indeterminateFailure).toMatchObject({
        dependency: 'CATALOG',
        outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
      });
      expect(persistenceCalls).toBe(0);
    }),
  );

  it.effect('requires owner validation of the exact commercial scope at the Price effective instant', () =>
    Effect.gen(function* requireExactCommercialContext() {
      const requests: unknown[] = [];
      const result = yield* applyPriceDefinition(payload, trusted, {
        ...servicesFor(() => Effect.succeed(persistenceSuccess('CREATED'))),
        assessCommercialContext: (request) => {
          requests.push(request);
          return Effect.succeed(validCommercialContextAssessment);
        },
      });

      expect(result.outcome).toBe('PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED');
      expect(requests).toEqual([
        {
          assessedAt: DateTime.makeUnsafe(payload.effectiveFrom),
          commercialScope: payload.identityKey.commercialScope,
          tenantId,
        },
      ]);
    }),
  );

  it.effect(
    'rejects an owner-invalid commercial tuple and retries unverifiable owner evidence without persistence',
    () =>
      Effect.gen(function* rejectUnprovenCommercialContext() {
        let persistenceCalls = 0;
        const define: DefinePriceActionServices['define'] = () => {
          persistenceCalls += 1;
          return Effect.succeed(persistenceSuccess('CREATED'));
        };
        const invalidFailure = yield* applyPriceDefinition(
          payload,
          trusted,
          servicesFor(define, validCatalogAssessment, {
            reason: 'Commerce Market did not validate the exact tuple',
            status: 'INVALID',
          }),
        );
        const unavailableFailure = yield* applyPriceDefinition(payload, trusted, {
          ...servicesFor(define),
          assessCommercialContext: () =>
            Effect.fail(
              new PricingCommercialContextUnavailable({
                code: 'pricing_commercial_context_unavailable',
                reason: 'Commerce Market current snapshot is unavailable',
                retryable: true,
              }),
            ),
        });

        expect(invalidFailure).toMatchObject({
          outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
          reason: 'MARKET_MISSING',
        });
        expect(unavailableFailure).toMatchObject({
          dependency: 'COMMERCE_MARKET_CATALOG',
          outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
        });
        expect(persistenceCalls).toBe(0);
      }),
  );

  it.effect('keeps key conflicts and future-first-revision rejection distinct', () =>
    Effect.gen(function* rejectConflicts() {
      const conflict = yield* applyPriceDefinition(
        payload,
        trusted,
        servicesFor(() => Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'EXACT_KEY_ALREADY_BOUND' as const })),
      );
      const future = yield* applyPriceDefinition(
        payload,
        trusted,
        servicesFor(() => Effect.succeed({ outcome: 'EFFECTIVE_TIME_INVALID' as const })),
      );
      const invalidProvenance = yield* applyPriceDefinition(
        payload,
        trusted,
        servicesFor(() => Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'SOURCE_LINEAGE_INVALID' as const })),
      );
      const duplicateSourceFact = yield* applyPriceDefinition(
        payload,
        trusted,
        servicesFor(() => Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'SOURCE_FACT_CONFLICT' as const })),
      );
      expect(conflict).toMatchObject({ outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD' });
      expect(future).toMatchObject({ outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID' });
      expect(invalidProvenance).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
        reason: 'MAPPING_REJECTED',
      });
      expect(duplicateSourceFact).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'DUPLICATE_CORRELATION_HELD',
      });
    }),
  );

  it.effect('reports unavailable canonical persistence as a retryable dependency outcome', () =>
    Effect.gen(function* reportPersistenceDependency() {
      const result = yield* applyPriceDefinition(
        payload,
        trusted,
        servicesFor(() => Effect.fail(new PricePersistenceUnavailable({ reason: 'database unavailable' }))),
      );

      expect(result).toMatchObject({
        dependency: 'PERSISTENCE',
        outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE',
        retryable: true,
        sourceAssertionId: payload.sourceAssertion.sourceAssertionId,
      });
    }),
  );

  it('rejects Storefront and purchase Quantity from the mutation payload', () => {
    const decodeClosed = Schema.decodeUnknownSync(DefinePricePayloadSchema, { onExcessProperty: 'error' });
    expect(() => decodeClosed({ ...payload, storefrontId: 'storefront-web' })).toThrow();
    expect(() => decodeClosed({ ...payload, quantity: '12' })).toThrow();
  });

  it('rejects Price decimals that cannot be stored exactly as numeric(38,9)', () => {
    const decodeClosed = Schema.decodeUnknownSync(DefinePricePayloadSchema, { onExcessProperty: 'error' });
    expect(
      decodeClosed({ ...payload, monetaryAmount: { ...payload.monetaryAmount, amount: '0.123456789' } }),
    ).toBeDefined();
    for (const amount of ['0.0000000001', '999999999999999999999999999999.123456789']) {
      expect(() => decodeClosed({ ...payload, monetaryAmount: { ...payload.monetaryAmount, amount } })).toThrow();
    }
    for (const quantity of ['1.0000000001', '1.0000000002']) {
      expect(() =>
        decodeClosed({
          ...payload,
          identityKey: { ...identityKey, unitBasis: { ...identityKey.unitBasis, quantity } },
        }),
      ).toThrow();
    }
  });
});
