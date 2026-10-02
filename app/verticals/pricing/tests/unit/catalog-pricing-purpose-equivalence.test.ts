import type { executePricingPurposeEquivalenceWithAuthorization } from '@app/catalog/api/pricing-purpose-equivalence-client';
import { CatalogQuantityHandoffReadySchema } from '@app/catalog/domain/catalog-quantity-handoff';
import { QuantityTierAggregationAttemptSchema } from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import { Effect, Redacted, Schema } from 'effect';
import { HttpClientError, HttpClientRequest } from 'effect/unstable/http';
import { describe, expect, it } from 'effect-rstest';

import { CatalogSelectionGatewayCredentialService } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import { catalogPricingPurposeEquivalencePortFromEnvironment } from '../../src/integrations/catalog-pricing-purpose-equivalence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const evaluatedAt = '2026-09-27T10:00:00.000Z';
const suppliedObservedAt = '2026-09-27T09:59:59.000Z';
const ownerObservedAt = '2026-09-27T10:00:01.000Z';
const validThrough = '2026-09-27T11:00:00.000Z';
const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.product');
const variantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');
const unitRef = catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.product-unit');
const selection = { productRef, variantRef };
const occurrenceId = 'purchase-occurrence-a';
const candidateRef = 'candidate:purchase-a';

const handoff = Schema.decodeUnknownSync(CatalogQuantityHandoffReadySchema)({
  completeness: {
    nextApplicabilityBoundary: validThrough,
    observedAt: suppliedObservedAt,
    ownerRevision: 'catalog-quantity:17',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-quantity:purchase-occurrence-a' },
  },
  divisible: true,
  equivalentSelectionKey: 'catalog-selection:pricing-purpose-a',
  evidence: {
    assessedAt: suppliedObservedAt,
    basis: [
      { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
      { role: 'VARIANT', source: { resourceRef: variantRef, revision: 2 } },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: productRef, revision: 1 },
      },
      { role: 'UNIT_RULE', source: { resourceRef: unitRef, revision: 7 } },
      { role: 'UNIT_TARGET_DIVISIBILITY', source: { resourceRef: variantRef, revision: 3 } },
    ],
    membership: {
      attestationId: 'catalog-membership-a',
      observedAt: suppliedObservedAt,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: variantRef, revision: 2 },
    },
    purpose: 'PRICING',
    selection,
    status: 'VALID',
    validUntil: validThrough,
  },
  hierarchyRevision: 'catalog-hierarchy:9',
  ownerRevision: 'catalog-quantity:17',
  quantity: {
    changed: false,
    notice: null,
    requested: '2',
    resulting: '2',
    rounding: 'HALF_UP',
    status: 'VALID',
    step: '1',
    targetId: variantRef.resourceId,
    tenantId,
    unitId: unitRef.resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 7,
  },
  selection,
  status: 'READY',
  unitRef,
});

const currentHandoff = Schema.decodeSync(CatalogQuantityHandoffReadySchema)({
  ...handoff,
  completeness: { ...handoff.completeness, observedAt: ownerObservedAt },
  evidence: {
    ...handoff.evidence,
    assessedAt: ownerObservedAt,
    membership: { ...handoff.evidence.membership, observedAt: ownerObservedAt },
  },
});

const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const commercialScope = { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId };
const subject = {
  guestEvidenceRef: 'guest-evidence:pricing-purpose-equivalence',
  guestSessionRef: 'guest-session:pricing-purpose-equivalence',
  kind: 'GUEST' as const,
};
const line = { catalog: handoff, occurrenceId, pricingBasis: { quantity: '1', unitRef } };
const exactPrice = {
  path: { priceGroupSelector: { kind: 'NO_GROUP' as const }, requiredAbsenceEvidence: [] },
  price: {
    definition: {
      identityKey: {
        catalogSelection: selection,
        commercialScope,
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'NO_GROUP' as const },
        unitBasis: { quantity: '1', unitRef },
      },
      priceRef,
      revision: {
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        monetaryAmount: { amount: '100', currencyCode: 'CZK' },
        monetaryBoundary: 'PRE_TAX' as const,
        revision: 1,
        revisionId: '77777777-7777-4777-8777-777777777777',
      },
    },
    effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
    lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
  },
  scheduleRevision: 1,
};

const attempt = Schema.decodeUnknownSync(QuantityTierAggregationAttemptSchema)({
  candidate: {
    commercialScope,
    currencyCode: 'CZK',
    lines: [line],
    monetaryBoundary: 'PRE_TAX',
    operationTime: evaluatedAt,
    purchasingContext: {
      accessDecision: { decisionRef: 'access-decision:pricing-purpose-equivalence', decisionRevision: '1' },
      actor: {
        guestEvidenceRef: subject.guestEvidenceRef,
        guestSessionRef: subject.guestSessionRef,
        kind: 'GUEST',
      },
      commercialSettingsDecision: {
        decisionRef: 'commercial-settings:pricing-purpose-equivalence',
        decisionRevision: '1',
      },
      contextRef: 'commerce-purchasing-context:a',
      contextRevision: 'customer-context:a',
      currencyResolution: {
        currencyCode: 'CZK',
        resolutionRef: 'currency-resolution:pricing-purpose-equivalence',
        resolutionRevision: '1',
      },
      subject,
    },
    tenantId,
  },
  candidateRef,
  evaluatedAt,
  participants: [
    {
      candidateRef,
      exactPrice,
      line,
      normalizedQuantity: {
        quantity: '2',
        quantityBasis: {
          catalogQuantityBasis: handoff.quantityBasis,
          priceUnitBasis: { quantity: '1', unitRef },
        },
      },
    },
  ],
});

const confirmedResponse = {
  assessments: [
    { handoff: currentHandoff, role: 'ANCHOR' as const },
    { handoff: currentHandoff, occurrenceId, role: 'MEMBER' as const },
  ],
  currentness: { effectiveAt: evaluatedAt, observedAt: ownerObservedAt, status: 'CURRENT' as const, validThrough },
  currentnessEvidence: {
    effectiveAt: evaluatedAt,
    generation: 'catalog-pricing-purpose-equivalence-generation:a',
    observedAt: ownerObservedAt,
    predicateRef: 'catalog-pricing-purpose-equivalence-predicate:a',
    revalidatedAt: ownerObservedAt,
    validThrough,
    verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED' as const,
  },
  evidence: {
    anchorSelection: selection,
    assessmentId: 'catalog-pricing-purpose-equivalence-assessment:a',
    effectiveAt: evaluatedAt,
    members: [{ occurrenceId, selection }],
    observedAt: ownerObservedAt,
    ownerModuleId: 'commerce.catalog' as const,
    ownerRevision: 'catalog-pricing-purpose-equivalence:a',
    purpose: 'PRICING' as const,
    status: 'CONFIRMED' as const,
    validThrough,
  },
  generation: 'catalog-pricing-purpose-equivalence-generation:a',
  outcome: 'CATALOG_EQUIVALENCE_CONFIRMED' as const,
  verificationReceipt: {
    generation: 'catalog-pricing-purpose-equivalence-generation:a',
    issuedAt: ownerObservedAt,
    ownerModuleId: 'commerce.catalog' as const,
    ownerRevision: 'catalog-pricing-purpose-equivalence:a',
    predicate: {
      anchor: {
        quantityBasis: currentHandoff.quantityBasis,
        requestedQuantity: currentHandoff.quantity.requested,
        selection,
      },
      effectiveAt: evaluatedAt,
      members: [
        {
          occurrenceId,
          quantityBasis: currentHandoff.quantityBasis,
          requestedQuantity: currentHandoff.quantity.requested,
          selection,
        },
      ],
      purpose: 'PRICING' as const,
    },
    predicateRef: 'catalog-pricing-purpose-equivalence-predicate:a',
    verificationRef: 'catalog-pricing-purpose-equivalence-verification:a',
  },
};

const gateway = {
  issue: () =>
    Effect.succeed({
      baseUrl: new URL('https://catalog.example.test'),
      credential: Redacted.make('Bearer catalog-owner-assertion'),
    }),
};

describe('Pricing Catalog Pricing-purpose equivalence adapter', () => {
  it.effect('uses the generated owner client and preserves effective and later observation times', () =>
    Effect.gen(function* ownerConfirmed() {
      const calls: unknown[] = [];
      const port = yield* catalogPricingPurposeEquivalencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-purpose-equivalence', tenantId },
        (payload, credential, requestCorrelation, options) =>
          Effect.sync(() => {
            calls.push({ credential: Redacted.value(credential), options, payload, requestCorrelation });
            return confirmedResponse;
          }),
      );

      const resolution = yield* port.resolve(attempt);

      expect(resolution).toMatchObject({
        evidence: { effectiveAt: evaluatedAt, observedAt: ownerObservedAt, validThrough },
        outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
      });
      expect(calls).toEqual([
        {
          credential: 'Bearer catalog-owner-assertion',
          options: { baseUrl: new URL('https://catalog.example.test') },
          payload: {
            anchorSelection: selection,
            effectiveAt: evaluatedAt,
            members: [{ handoff, occurrenceId }],
          },
          requestCorrelation: 'pricing-purpose-equivalence',
        },
      ]);
      expect(calls[0]).not.toHaveProperty('currencyCode');
      expect(calls[0]).not.toHaveProperty('storefrontId');
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('projects every non-confirmed observed owner outcome to typed unverifiable', () =>
    Effect.gen(function* typedFailures() {
      const outcomes = [
        ['CATALOG_EQUIVALENCE_NON_EQUIVALENT', 'CURRENT'],
        ['CATALOG_EQUIVALENCE_CONFLICT', 'CONFLICT'],
        ['CATALOG_EQUIVALENCE_STALE', 'STALE'],
        ['CATALOG_EQUIVALENCE_UNVERIFIABLE', 'UNVERIFIABLE'],
      ] as const;
      for (const [outcome, status] of outcomes) {
        const port = yield* catalogPricingPurposeEquivalencePortFromEnvironment(
          { legalEntityId, requestCorrelation: 'pricing-purpose-equivalence', tenantId },
          () =>
            Effect.succeed({
              assessments: confirmedResponse.assessments,
              currentness: { effectiveAt: evaluatedAt, observedAt: ownerObservedAt, status, validThrough },
              evidenceRef: `catalog-pricing-purpose-equivalence:${outcome}`,
              outcome,
              reason: 'Catalog owner did not confirm equivalence',
            }),
        );
        expect(yield* port.resolve(attempt)).toEqual({
          evidenceRef: `catalog-pricing-purpose-equivalence:${outcome}`,
          outcome: 'CATALOG_EQUIVALENCE_UNVERIFIABLE',
        });
      }
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('preserves Catalog unavailable without fabricating equivalence evidence', () =>
    Effect.gen(function* typedUnavailable() {
      const port = yield* catalogPricingPurposeEquivalencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-purpose-equivalence', tenantId },
        () =>
          Effect.succeed({
            currentness: { effectiveAt: evaluatedAt, status: 'UNAVAILABLE' as const },
            outcome: 'CATALOG_EQUIVALENCE_UNAVAILABLE' as const,
            reason: 'Catalog Current facts are unavailable',
            retryable: true,
          }),
      );
      expect(yield* port.resolve(attempt)).toEqual({ outcome: 'CATALOG_EQUIVALENCE_UNAVAILABLE' });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('rejects owner evidence that substitutes an exact Unit rule revision', () =>
    Effect.gen(function* rejectSubstitution() {
      const substituted = {
        ...currentHandoff,
        quantity: { ...currentHandoff.quantity, unitRuleRevision: 8 },
        quantityBasis: { ...currentHandoff.quantityBasis, unitRuleRevision: 8 },
      };
      const port = yield* catalogPricingPurposeEquivalencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-purpose-equivalence', tenantId },
        () =>
          Effect.succeed({
            ...confirmedResponse,
            assessments: [
              confirmedResponse.assessments[0],
              { handoff: substituted, occurrenceId, role: 'MEMBER' as const },
            ],
          }),
      );
      expect(yield* port.resolve(attempt).pipe(Effect.flip)).toMatchObject({
        code: 'pricing_catalog_selection_unavailable',
        retryable: true,
      });

      const substitutedTopLevelUnit = {
        ...currentHandoff,
        unitRef: catalogRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'commerce.catalog.product-unit'),
      };
      const unitIdentityPort = yield* catalogPricingPurposeEquivalencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-purpose-equivalence', tenantId },
        () =>
          Effect.succeed({
            ...confirmedResponse,
            assessments: [
              confirmedResponse.assessments[0],
              { handoff: substitutedTopLevelUnit, occurrenceId, role: 'MEMBER' as const },
            ],
          }),
      );
      expect(yield* unitIdentityPort.resolve(attempt).pipe(Effect.flip)).toMatchObject({
        code: 'pricing_catalog_selection_unavailable',
        retryable: true,
      });

      const boundarylessEvidence = { ...currentHandoff.evidence };
      const boundarylessCompleteness = { ...currentHandoff.completeness };
      Reflect.deleteProperty(boundarylessEvidence, 'validUntil');
      Reflect.deleteProperty(boundarylessCompleteness, 'nextApplicabilityBoundary');
      const boundaryless = {
        ...currentHandoff,
        completeness: boundarylessCompleteness,
        evidence: boundarylessEvidence,
      };
      const mixedValidityPort = yield* catalogPricingPurposeEquivalencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-purpose-equivalence', tenantId },
        () =>
          Effect.succeed({
            ...confirmedResponse,
            assessments: [
              confirmedResponse.assessments[0],
              { handoff: boundaryless, occurrenceId, role: 'MEMBER' as const },
            ],
          }),
      );
      expect(yield* mixedValidityPort.resolve(attempt).pipe(Effect.flip)).toMatchObject({
        code: 'pricing_catalog_selection_unavailable',
        retryable: true,
      });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('accepts a fresh owner attestation when material facts remain the same', () =>
    Effect.gen(function* acceptsFreshOwnerRevision() {
      const substituted = {
        ...currentHandoff,
        completeness: { ...currentHandoff.completeness, ownerRevision: 'catalog-quantity:18' },
        ownerRevision: 'catalog-quantity:18',
      };
      const port = yield* catalogPricingPurposeEquivalencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-purpose-equivalence', tenantId },
        () =>
          Effect.succeed({
            ...confirmedResponse,
            assessments: [
              confirmedResponse.assessments[0],
              { handoff: substituted, occurrenceId, role: 'MEMBER' as const },
            ],
          }),
      );
      expect(yield* port.resolve(attempt)).toMatchObject({
        outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
      });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('rejects a Price for a different Market before calling Catalog', () =>
    Effect.gen(function* rejectsMarketSubstitution() {
      const wrongMarket = yield* Schema.decodeUnknownEffect(QuantityTierAggregationAttemptSchema)({
        ...attempt,
        participants: attempt.participants.map((participant) => ({
          ...participant,
          exactPrice: {
            ...participant.exactPrice,
            price: {
              ...participant.exactPrice.price,
              definition: {
                ...participant.exactPrice.price.definition,
                identityKey: {
                  ...participant.exactPrice.price.definition.identityKey,
                  commercialScope: { ...commercialScope, marketId: 'other-market' },
                },
              },
            },
          },
        })),
      });
      let transported = false;
      const port = yield* catalogPricingPurposeEquivalencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-purpose-equivalence', tenantId },
        () =>
          Effect.sync(() => {
            transported = true;
            return confirmedResponse;
          }),
      );

      expect(yield* port.resolve(wrongMarket).pipe(Effect.flip)).toMatchObject({
        code: 'pricing_catalog_selection_unavailable',
        retryable: true,
      });
      expect(transported).toBe(false);
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('fails typed unavailable for missing credentials and generated-client transport failure', () =>
    Effect.gen(function* unavailableBoundaries() {
      const missingCredentialPort = yield* catalogPricingPurposeEquivalencePortFromEnvironment({
        legalEntityId,
        requestCorrelation: 'pricing-purpose-equivalence',
        tenantId,
      });
      expect(yield* missingCredentialPort.resolve(attempt).pipe(Effect.flip)).toMatchObject({
        code: 'pricing_catalog_selection_unavailable',
        retryable: true,
      });

      const request = HttpClientRequest.post('https://catalog.example.test/reads/pricing-purpose-equivalence');
      const execute = (): ReturnType<typeof executePricingPurposeEquivalenceWithAuthorization> =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              cause: new Error('Catalog transport failed'),
              description: 'transport unavailable',
              request,
            }),
          }),
        );
      const transportPort = yield* catalogPricingPurposeEquivalencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-purpose-equivalence', tenantId },
        execute,
      );
      expect(yield* transportPort.resolve(attempt).pipe(Effect.flip)).toMatchObject({
        code: 'pricing_catalog_selection_unavailable',
        retryable: true,
      });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('rejects an untrusted Tenant or Selling Legal Entity before owner transport', () =>
    Effect.gen(function* trustedScopeOnly() {
      for (const context of [
        {
          legalEntityId,
          requestCorrelation: 'pricing-purpose-equivalence',
          tenantId: '11111111-1111-4111-8111-111111111199',
        },
        {
          legalEntityId: '22222222-2222-4222-8222-222222222299',
          requestCorrelation: 'pricing-purpose-equivalence',
          tenantId,
        },
      ]) {
        let transported = false;
        const port = yield* catalogPricingPurposeEquivalencePortFromEnvironment(context, () =>
          Effect.sync(() => {
            transported = true;
            return confirmedResponse;
          }),
        );
        expect(yield* port.resolve(attempt).pipe(Effect.flip)).toMatchObject({
          code: 'pricing_catalog_selection_unavailable',
          retryable: true,
        });
        expect(transported).toBe(false);
      }
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );
});
