import type { PricingMaterialEvidenceFenceSource } from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingOwnerMaterialEvidenceFenceGatewayRequestSchema,
  PricingMaterialEvidenceUnverifiableFailure,
} from '@app/pricing-contracts/domain/material-evidence';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingCatalogMaterialEvidenceFenceGateway,
  PricingCustomerContextMaterialEvidenceFenceGateway,
  PricingMarketMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGatewayUnavailable,
  PricingPricingMaterialEvidenceFenceGateway,
  PricingPromotionMaterialEvidenceFenceGateway,
  makePricingMaterialEvidenceOwnerFinalFence,
  makePricingMaterialEvidenceOwnerFinalFenceFromGateways,
} from '../../src/integrations/material-evidence-owner-final-fence.ts';
import type {
  PricingOwnerMaterialEvidenceGenerationConfirmation,
  PricingOwnerMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGatewayResult,
} from '../../src/integrations/material-evidence-owner-final-fence.ts';
import {
  PricingMaterialEvidenceChangedAtFinalFence,
  PricingMaterialEvidenceOwnerFinalFence,
  verifyPricingMaterialEvidenceOwnerFence,
} from '../../src/services/material-evidence-final-validation.service.ts';
import type {
  PricingMaterialEvidenceFenceExpectation,
  PricingMaterialEvidenceFenceSourceObservation,
} from '../../src/services/material-evidence-final-validation.service.ts';

const requestedAt = '2026-09-28T12:00:00.000Z';
const nextMaterialBoundary = '2026-09-28T13:00:00.000Z';

const sourceFor = (
  ownerModuleId: string,
  family: 'COMMERCIAL_CONTEXT' | 'PRICE' | 'PROMOTION',
  observedAt: string,
  suffix: string,
) => {
  const predicateRef = `${ownerModuleId}:predicate:${suffix}`;
  const ownerScope = {
    ownerModuleId,
    ownerRootRef: `${ownerModuleId}:root:tenant-786`,
    predicateRef,
    tenantId: 'tenant-786',
  };
  const temporal = {
    effectiveAt: requestedAt,
    evaluatedAt: observedAt,
    evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
    nextMaterialBoundary,
    observedAt,
    requestedAt,
  };
  const ownerSetRevisionRef = `${ownerModuleId}:set:${suffix}:a`;
  return Schema.decodeSync(PricingSourceEvidenceVerifiedPresentSchema, {
    onExcessProperty: 'error',
  })({
    _tag: 'VERIFIED_PRESENT',
    completeness: {
      completenessEvidence: {
        nextApplicabilityBoundary: nextMaterialBoundary,
        observedAt,
        ownerRevision: ownerSetRevisionRef,
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      family,
      ownerScope,
      ownerSetRevisionRef,
      temporal,
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
        verificationRef: `${ownerModuleId}:proof:set:${suffix}:a`,
      },
    },
    currentFacts: [
      {
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        factRef: `${ownerModuleId}:fact:${suffix}`,
        factRevisionRef: `${ownerModuleId}:revision:${suffix}:a`,
        family,
        ownerScope,
        temporal,
        verification: {
          kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
          verificationRef: `${ownerModuleId}:proof:fact:${suffix}:a`,
        },
      },
    ],
    request: { effectiveAt: requestedAt, family, ownerScope, requestedAt },
  });
};

const observationFor = (expectation: PricingMaterialEvidenceFenceExpectation, observedAt: string) => ({
  currencyCode: expectation.currencyCode,
  currentFacts: expectation.currentFacts,
  currentInvalidationGenerationRef: `generation:${expectation.evidenceVerificationRef}`,
  currentOwnerSetRevisionRef: expectation.ownerSetRevisionRef,
  evidenceInvalidationGenerationRef: `generation:${expectation.evidenceVerificationRef}`,
  evidenceVerificationRef: expectation.evidenceVerificationRef,
  family: expectation.family,
  observedAt,
  ownerModuleId: expectation.ownerModuleId,
  ownerRootRef: expectation.ownerRootRef,
  predicateRef: expectation.predicateRef,
  tenantId: expectation.tenantId,
});

const confirmationFor = (
  observation: PricingMaterialEvidenceFenceSourceObservation,
): PricingOwnerMaterialEvidenceGenerationConfirmation => ({
  currentFacts: observation.currentFacts,
  currentInvalidationGenerationRef: observation.currentInvalidationGenerationRef,
  currentOwnerSetRevisionRef: observation.currentOwnerSetRevisionRef,
  evidenceInvalidationGenerationRef: observation.evidenceInvalidationGenerationRef,
  evidenceVerificationRef: observation.evidenceVerificationRef,
});

const gateway = (
  observedAt: string,
  completedAt: string,
  phaseOneChange?: (expectation: PricingMaterialEvidenceFenceExpectation) => ReturnType<typeof observationFor>,
  generationChange?: (
    observation: PricingMaterialEvidenceFenceSourceObservation,
  ) => PricingOwnerMaterialEvidenceGenerationConfirmation,
): PricingOwnerMaterialEvidenceFenceGateway => ({
  confirmObservedGenerationsThrough: ({ observations, through }) =>
    Effect.succeed({
      confirmations: observations.map((observation) =>
        generationChange === undefined ? confirmationFor(observation) : generationChange(observation),
      ),
      verifiedThrough: through,
    }),
  verifyOpaqueProofsAgainstCurrentState: ({ sources }): Effect.Effect<PricingOwnerMaterialEvidenceFenceGatewayResult> =>
    Effect.succeed({
      completedAt,
      observations: sources.map((expectation) =>
        phaseOneChange === undefined ? observationFor(expectation, observedAt) : phaseOneChange(expectation),
      ),
    }),
});

const ownerLayers = (overrides?: {
  readonly catalog?: PricingOwnerMaterialEvidenceFenceGateway;
  readonly promotion?: PricingOwnerMaterialEvidenceFenceGateway;
}) =>
  Layer.mergeAll(
    Layer.succeed(
      PricingPricingMaterialEvidenceFenceGateway,
      gateway('2026-09-28T12:00:10.100Z', '2026-09-28T12:00:10.150Z'),
    ),
    Layer.succeed(
      PricingCatalogMaterialEvidenceFenceGateway,
      overrides?.catalog ?? gateway('2026-09-28T12:00:10.200Z', '2026-09-28T12:00:10.250Z'),
    ),
    Layer.succeed(
      PricingMarketMaterialEvidenceFenceGateway,
      gateway('2026-09-28T12:00:10.300Z', '2026-09-28T12:00:10.350Z'),
    ),
    Layer.succeed(
      PricingCustomerContextMaterialEvidenceFenceGateway,
      gateway('2026-09-28T12:00:10.400Z', '2026-09-28T12:00:10.450Z'),
    ),
    Layer.succeed(
      PricingPromotionMaterialEvidenceFenceGateway,
      overrides?.promotion ?? gateway('2026-09-28T12:00:10.500Z', '2026-09-28T12:00:10.550Z'),
    ),
  );

const live = (overrides?: Parameters<typeof ownerLayers>[0]) =>
  Layer.effect(PricingMaterialEvidenceOwnerFinalFence, makePricingMaterialEvidenceOwnerFinalFence('revision:786')).pipe(
    Layer.provide(ownerLayers(overrides)),
  );

const sources = [
  sourceFor('commerce.pricing', 'PRICE', '2026-09-28T12:00:00.100Z', 'price'),
  sourceFor('commerce.catalog', 'COMMERCIAL_CONTEXT', '2026-09-28T12:00:00.200Z', 'catalog'),
  sourceFor('commerce.market-catalog', 'COMMERCIAL_CONTEXT', '2026-09-28T12:00:00.300Z', 'market'),
  sourceFor('commerce.customer-context', 'COMMERCIAL_CONTEXT', '2026-09-28T12:00:00.400Z', 'group'),
  sourceFor('commerce.promotion', 'PROMOTION', '2026-09-28T12:00:00.500Z', 'promotion'),
];

describe('Pricing material-evidence production owner fence #786', () => {
  it.layer(live())((test) => {
    test.effect('executes the Live five-owner composition and preserves distinct owner timestamps', () =>
      Effect.gen(function* unchangedStateSucceeds() {
        const result = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', sources);

        expect(result.observedAt).toBe('2026-09-28T12:00:10.550Z');
        expect(result.sources.map(({ observedAt }) => observedAt)).toEqual([
          '2026-09-28T12:00:10.100Z',
          '2026-09-28T12:00:10.200Z',
          '2026-09-28T12:00:10.300Z',
          '2026-09-28T12:00:10.400Z',
          '2026-09-28T12:00:10.500Z',
        ]);
      }),
    );
  });

  const changedCatalog = gateway('2026-09-28T12:00:10.200Z', '2026-09-28T12:00:10.250Z', undefined, (observation) => ({
    ...confirmationFor(observation),
    currentFacts: [
      ...observation.currentFacts,
      {
        factRef: 'commerce.catalog:fact:catalog-b',
        factRevisionRef: 'commerce.catalog:revision:catalog-b',
        verificationRef: 'commerce.catalog:proof:fact:catalog-b',
      },
    ],
    currentInvalidationGenerationRef: 'commerce.catalog:generation:b-at-12:00:10.350Z',
    currentOwnerSetRevisionRef: 'commerce.catalog:set:catalog:b',
  }));
  it.layer(live({ catalog: changedCatalog }))((test) => {
    test.effect('fails retryably when Catalog changes from A after t1 before slow Promotion completes at t2', () =>
      Effect.gen(function* changedStateFails() {
        const failure = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', sources).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(PricingMaterialEvidenceChangedAtFinalFence);
        expect(failure).toMatchObject({
          family: 'COMMERCIAL_CONTEXT',
          predicateRef: 'commerce.catalog:predicate:catalog',
          retryable: true,
        });
      }),
    );
  });

  const unavailablePromotion: PricingOwnerMaterialEvidenceFenceGateway = {
    confirmObservedGenerationsThrough: () =>
      Effect.fail(
        new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
          ownerModuleId: 'commerce.promotion',
          reason: 'Promotion owner generation confirmation timed out',
          retryable: true,
        }),
      ),
    verifyOpaqueProofsAgainstCurrentState: () =>
      Effect.fail(
        new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
          ownerModuleId: 'commerce.promotion',
          reason: 'Promotion owner read timed out',
          retryable: true,
        }),
      ),
  };
  it.layer(live({ promotion: unavailablePromotion }))((test) => {
    test.effect('maps a Promotion owner outage to a typed retryable publication failure', () =>
      Effect.gen(function* ownerOutageFailsTyped() {
        const failure = yield* verifyPricingMaterialEvidenceOwnerFence('candidate-786', sources).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(PricingMaterialEvidenceUnverifiableFailure);
        expect(failure).toMatchObject({
          family: 'PROMOTION',
          predicateRef: 'commerce.promotion:predicate:promotion',
          retryable: true,
        });
        expect(failure.cause).toBeInstanceOf(PricingOwnerMaterialEvidenceFenceGatewayUnavailable);
      }),
    );
  });
});

const completeCatalogFixture1225 = () => {
  const tenantId = '22222222-2222-4222-8222-222222222222';
  const effectiveAt = '2026-09-28T10:00:00.000Z';
  const fixtureRequestedAt = '2026-09-28T09:59:59.000Z';
  const ownerEvaluatedAt = '2026-09-28T10:00:00.200Z';
  const ownerObservedAt = '2026-09-28T10:00:00.500Z';
  const evaluatedAt = '2026-09-28T10:00:01.000Z';

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
  const catalog = {
    completeness: {
      nextApplicabilityBoundary: '2026-09-28T11:00:00.000Z',
      observedAt: ownerObservedAt,
      ownerRevision: 'opaque:commerce.catalog:set-revision',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog:selection-a' },
    },
    divisible: false,
    equivalentSelectionKey: 'catalog-selection:selection-a',
    evidence: {
      assessedAt: effectiveAt,
      basis: [
        { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
        { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 2 } },
        {
          provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
          role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
          source: { resourceRef: productRef, revision: 1 },
        },
      ],
      membership: {
        attestationId: '99999999-9999-4999-8999-999999999999',
        observedAt: effectiveAt,
        productRef,
        source: 'CATALOG_OWNER_CURRENT_READ' as const,
        variant: { resourceRef: variantRef, revision: 2 },
      },
      purpose: 'PRICING',
      selection,
      status: 'VALID',
      validUntil: '2026-09-28T11:00:00.000Z',
    },
    hierarchyRevision: 'catalog-hierarchy:9',
    ownerRevision: 'opaque:commerce.catalog:set-revision',
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
  } as const;
  const line = {
    catalog,
    occurrenceId: 'occurrence-a',
    pricingBasis: { quantity: '1', unitRef },
  } as const;
  const decision = {
    commercialScope: {
      channelId: 'B2C',
      marketId: 'cz-launch',
      sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    currencyCode: 'CZK',
    lines: [line],
    monetaryBoundary: 'PRE_TAX',
    operationTime: effectiveAt,
    purchasingContext: {
      accessDecision: {
        decisionRef: 'purchase-access-decision:a',
        decisionRevision: 'purchase-access-decision-revision:a',
      },
      actor: {
        guestEvidenceRef: 'guest-evidence:a',
        guestSessionRef: 'guest-session:a',
        kind: 'GUEST',
      },
      commercialSettingsDecision: {
        decisionRef: 'purchase-commercial-settings:a',
        decisionRevision: 'purchase-commercial-settings-revision:a',
      },
      contextRef: 'purchase-context:a',
      contextRevision: 'purchase-context-revision:a',
      currencyResolution: {
        currencyCode: 'CZK',
        resolutionRef: 'purchase-currency-resolution:a',
        resolutionRevision: 'purchase-currency-resolution-revision:a',
      },
      subject: {
        guestEvidenceRef: 'guest-evidence:a',
        guestSessionRef: 'guest-session:a',
        kind: 'GUEST',
      },
    },
    tenantId,
  } as const;

  const verifiedSource = (
    ownerModuleId: string,
    family: 'COMMERCIAL_CONTEXT' | 'DISCOUNT' | 'PRICE' | 'PROMOTION',
    predicateRef: string,
    currencyCode?: 'CZK' | 'EUR',
  ) => {
    const ownerScope = {
      ownerModuleId,
      ownerRootRef: `opaque:${ownerModuleId}:root`,
      predicateRef,
      tenantId,
    };
    const temporal = {
      effectiveAt,
      evaluatedAt: ownerEvaluatedAt,
      evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
      nextMaterialBoundary: '2026-09-28T11:00:00.000Z',
      observedAt: ownerObservedAt,
      requestedAt: fixtureRequestedAt,
    };
    const requestBase = { effectiveAt, family, ownerScope, requestedAt: fixtureRequestedAt };
    const request = currencyCode === undefined ? requestBase : { ...requestBase, currencyCode };
    const completenessBase = {
      completenessEvidence: {
        nextApplicabilityBoundary: temporal.nextMaterialBoundary,
        observedAt: ownerObservedAt,
        ownerRevision: `opaque:${ownerModuleId}:set-revision`,
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef },
      },
      family,
      ownerScope,
      ownerSetRevisionRef: `opaque:${ownerModuleId}:set-revision`,
      temporal,
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
        verificationRef: `opaque:${ownerModuleId}:set-proof`,
      },
    };
    const completeness = currencyCode === undefined ? completenessBase : { ...completenessBase, currencyCode };
    const factBase = {
      effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
      factRef: `opaque:${ownerModuleId}:fact`,
      factRevisionRef: `opaque:${ownerModuleId}:fact-revision`,
      family,
      ownerScope,
      temporal,
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
        verificationRef: `opaque:${ownerModuleId}:fact-proof`,
      },
    };
    const fact = currencyCode === undefined ? factBase : { ...factBase, currencyCode };
    return { _tag: 'VERIFIED_PRESENT' as const, completeness, currentFacts: [fact], request };
  };

  const compatibilityRequest = {
    effectiveAt: catalog.evidence.assessedAt,
    handoff: catalog,
    price: { quantity: line.pricingBasis.quantity, quantityBasis: catalog.quantityBasis },
  };
  const compatibilityPredicate = {
    effectiveAt: compatibilityRequest.effectiveAt,
    price: compatibilityRequest.price,
    requestedQuantity: catalog.quantity.requested,
    requestedQuantityBasis: catalog.quantityBasis,
    requestedUnitRef: catalog.unitRef,
    selection: catalog.selection,
  };
  const compatibilityResponse = {
    completeness: catalog.completeness,
    currentness: {
      observedAt: ownerObservedAt,
      ownerRevision: catalog.ownerRevision,
      status: 'CURRENT' as const,
      validUntil: catalog.completeness.nextApplicabilityBoundary,
    },
    currentnessEvidence: {
      effectiveAt: compatibilityRequest.effectiveAt,
      generation: catalog.ownerRevision,
      observedAt: ownerObservedAt,
      predicateRef: catalog.completeness.scope.predicateRef,
      revalidatedAt: ownerObservedAt,
      validUntil: catalog.completeness.nextApplicabilityBoundary,
      verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED' as const,
    },
    effectiveAt: compatibilityRequest.effectiveAt,
    endpoints: {
      price: compatibilityRequest.price,
      purchase: { quantity: catalog.quantity.resulting, quantityBasis: catalog.quantityBasis },
      requested: { quantity: catalog.quantity.requested, quantityBasis: catalog.quantityBasis },
    },
    equivalentSelectionKey: catalog.equivalentSelectionKey,
    generation: catalog.ownerRevision,
    hierarchyRevision: catalog.hierarchyRevision,
    observedAt: ownerObservedAt,
    outcome: 'NO_CONVERSION_REQUIRED' as const,
    ownerModuleId: 'commerce.catalog' as const,
    ownerRevision: catalog.ownerRevision,
    requestedOwnerRevision: catalog.ownerRevision,
    requestedQuantity: catalog.quantity.requested,
    requestedQuantityBasis: catalog.quantityBasis,
    requestedUnitRef: catalog.unitRef,
    selection: catalog.selection,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    verificationReceipt: {
      generation: catalog.ownerRevision,
      issuedAt: ownerObservedAt,
      ownerModuleId: 'commerce.catalog' as const,
      ownerRevision: catalog.ownerRevision,
      predicate: compatibilityPredicate,
      predicateRef: catalog.completeness.scope.predicateRef,
      verificationRef: 'catalog-quantity-compatibility:verification:a',
    },
  };
  const catalogSource = {
    sourceEvidence: verifiedSource('commerce.catalog', 'COMMERCIAL_CONTEXT', 'catalog:selection-a'),
    verificationMaterial: {
      compatibilityRequest,
      compatibilityResponse,
      handoff: line.catalog,
      kind: 'CATALOG_LINE_AUTHORITY' as const,
      line,
      request: {
        amount: line.catalog.quantity.requested,
        purpose: 'PRICING' as const,
        selection: line.catalog.selection,
      },
    },
  };

  const guestSubject = {
    guestEvidenceRef: 'guest-evidence:a',
    guestSessionRef: 'guest-session:a',
    kind: 'GUEST' as const,
  };
  const purchaseAuthoritySource = {
    verificationMaterial: {
      evidence: {
        currentness: {
          evaluatedAt: effectiveAt,
          observedAt: ownerObservedAt,
          validFrom: '2026-09-28T09:00:00.000Z',
          validTo: null,
        },
        ownerRef: decision.purchasingContext.contextRef,
        ownerRevisionRef: decision.purchasingContext.contextRevision,
        subjectAuthority: {
          guestEvidenceAuthorityRef: 'guest-evidence-authority:a',
          guestSessionAuthorityRef: 'guest-session-authority:a',
          kind: 'GUEST' as const,
          subject: guestSubject,
          subjectAuthorityRevisionRef: 'guest-subject-revision:a',
        },
        verificationRef: 'purchase-context-verification:a',
        verifiedScope: {
          channelId: decision.commercialScope.channelId,
          legalEntityId: decision.commercialScope.sellingLegalEntityId,
          marketId: decision.commercialScope.marketId,
          tenantId,
        },
      },
      kind: 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY' as const,
      request: {
        actor: { kind: 'GUEST' as const },
        operationTime: effectiveAt,
        purchasingContext: {
          channelId: decision.commercialScope.channelId,
          contextRef: decision.purchasingContext.contextRef,
          contextRevision: decision.purchasingContext.contextRevision,
          marketId: decision.commercialScope.marketId,
          sellingLegalEntityId: decision.commercialScope.sellingLegalEntityId,
        },
        subject: guestSubject,
        tenantId,
      },
    },
  };
  const equivalenceSourceFor = (
    members: readonly { readonly catalog: typeof catalog; readonly occurrenceId: string }[],
  ) => {
    const [anchor] = members;
    if (anchor === undefined) {
      throw new Error('TEST fixture requires an anchor');
    }
    const sourceEvidence = verifiedSource('commerce.catalog', 'COMMERCIAL_CONTEXT', 'catalog:equivalence');

    const generation = 'catalog:equivalence:generation';
    const { predicateRef } = sourceEvidence.request.ownerScope;
    const validThrough = sourceEvidence.completeness.temporal.nextMaterialBoundary;
    return {
      sourceEvidence,
      verificationMaterial: {
        kind: 'CATALOG_EQUIVALENCE_AUTHORITY' as const,
        request: {
          anchorSelection: anchor.catalog.selection,
          effectiveAt,
          members: members.map(({ catalog: handoff, occurrenceId }) => ({ handoff, occurrenceId })),
        },
        response: {
          assessments: [
            { handoff: anchor.catalog, role: 'ANCHOR' as const },
            ...members.map(({ catalog: handoff, occurrenceId }) => ({
              handoff,
              occurrenceId,
              role: 'MEMBER' as const,
            })),
          ],
          currentness: { effectiveAt, observedAt: ownerObservedAt, status: 'CURRENT' as const, validThrough },
          currentnessEvidence: {
            effectiveAt,
            generation,
            observedAt: ownerObservedAt,
            predicateRef,
            revalidatedAt: ownerObservedAt,
            validThrough,
            verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED' as const,
          },
          evidence: {
            anchorSelection: anchor.catalog.selection,
            assessmentId: 'catalog:equivalence:assessment',
            effectiveAt,
            members: members.map(({ catalog: handoff, occurrenceId }) => ({
              occurrenceId,
              selection: handoff.selection,
            })),
            observedAt: ownerObservedAt,
            ownerModuleId: 'commerce.catalog' as const,
            ownerRevision: sourceEvidence.completeness.ownerSetRevisionRef,
            purpose: 'PRICING' as const,
            status: 'CONFIRMED' as const,
            validThrough,
          },
          generation,
          outcome: 'CATALOG_EQUIVALENCE_CONFIRMED' as const,
          verificationReceipt: {
            generation,
            issuedAt: ownerObservedAt,
            ownerModuleId: 'commerce.catalog' as const,
            ownerRevision: sourceEvidence.completeness.ownerSetRevisionRef,
            predicate: {
              anchor: {
                quantityBasis: anchor.catalog.quantityBasis,
                requestedQuantity: anchor.catalog.quantity.requested,
                selection: anchor.catalog.selection,
              },
              effectiveAt,
              members: members.map(({ catalog: handoff, occurrenceId }) => ({
                occurrenceId,
                quantityBasis: handoff.quantityBasis,
                requestedQuantity: handoff.quantity.requested,
                selection: handoff.selection,
              })),
              purpose: 'PRICING' as const,
            },
            predicateRef,
            verificationRef: sourceEvidence.completeness.verification.verificationRef,
          },
        },
      },
    };
  };

  const secondLine = { ...line, occurrenceId: 'occurrence-b' };
  const secondSource = {
    ...catalogSource,
    verificationMaterial: { ...catalogSource.verificationMaterial, line: secondLine },
  };
  return Schema.decodeUnknownSync(PricingOwnerMaterialEvidenceFenceGatewayRequestSchema)({
    candidateRef: 'candidate:1225',
    decision: { ...decision, lines: [line, secondLine] },
    effectiveAt,
    evaluatedAt,
    requestedAt: fixtureRequestedAt,
    sources: [
      catalogSource,
      secondSource,
      equivalenceSourceFor([line]),
      equivalenceSourceFor([secondLine]),
      purchaseAuthoritySource,
    ],
    subject: guestSubject,
  });
};

const catalogOccurrence1225 = ({ verificationMaterial }: PricingMaterialEvidenceFenceSource) => {
  if (verificationMaterial.kind === 'CATALOG_LINE_AUTHORITY') {
    return verificationMaterial.line.occurrenceId;
  }
  if (verificationMaterial.kind === 'CATALOG_EQUIVALENCE_AUTHORITY') {
    return verificationMaterial.request.members[0]?.occurrenceId ?? 'missing';
  }
  return 'foreign';
};

it.effect('preserves equal-ref distinct Catalog occurrences through final validation and both owner phases #1225', () =>
  Effect.gen(function* completeCatalogMultiplicity() {
    const typed = completeCatalogFixture1225();
    const rawSources = typed.sources.flatMap((source) => ('sourceEvidence' in source ? [source.sourceEvidence] : []));
    const received: string[][] = [];
    const replayed: string[][] = [];
    const catalogGateway: PricingOwnerMaterialEvidenceFenceGateway = {
      confirmObservedGenerationsThrough: (request) => {
        replayed.push((request.typedSources ?? []).map(catalogOccurrence1225));
        return Effect.succeed({
          confirmations: request.observations.map(confirmationFor),
          verifiedThrough: request.through,
        });
      },
      verifyOpaqueProofsAgainstCurrentState: (request) => {
        received.push((request.typedSources ?? []).map(catalogOccurrence1225));
        return Effect.succeed({
          completedAt: '2026-09-28T10:00:02.000Z',
          observations: request.sources.map((source) => observationFor(source, '2026-09-28T10:00:01.500Z')),
        });
      },
    };
    const empty = gateway('2026-09-28T10:00:01.500Z', '2026-09-28T10:00:02.000Z');
    const ownerFence = makePricingMaterialEvidenceOwnerFinalFenceFromGateways(
      {
        'commerce.catalog': catalogGateway,
        'commerce.customer-context': empty,
        'commerce.market-catalog': empty,
        'commerce.pricing': empty,
        'commerce.promotion': empty,
      },
      'test:1225',
    );
    const result = yield* verifyPricingMaterialEvidenceOwnerFence(typed.candidateRef, rawSources, typed).pipe(
      Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, ownerFence),
    );
    expect(received).toEqual([['occurrence-a', 'occurrence-b', 'occurrence-a', 'occurrence-b']]);
    expect(replayed).toEqual(received);
    expect(result.sources).toHaveLength(4);
    expect(result.sources.map(({ evidenceVerificationRef }) => evidenceVerificationRef)).toEqual(
      rawSources.map(({ completeness }) => completeness.verification.verificationRef),
    );
  }),
);

it.effect('rejects omitted, extra or reordered Catalog material before any owner attempt #1225', () =>
  Effect.gen(function* rejectsPartialCatalogMaterial() {
    const typed = completeCatalogFixture1225();
    const rawSources = typed.sources.flatMap((source) => ('sourceEvidence' in source ? [source.sourceEvidence] : []));
    const [first] = rawSources;
    if (first === undefined) {
      return yield* Effect.die('TEST fixture requires Catalog material');
    }
    for (const candidate of [rawSources.slice(1), [...rawSources, first], [...rawSources].toReversed()]) {
      let invoked = false;
      const failure = yield* verifyPricingMaterialEvidenceOwnerFence(typed.candidateRef, candidate, typed).pipe(
        Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, {
          verifyImmediatelyBeforePublication: () => {
            invoked = true;
            return Effect.die('Incomplete Catalog coverage must fail before owner replay');
          },
        }),
        Effect.flip,
      );
      expect(failure).toBeInstanceOf(PricingMaterialEvidenceUnverifiableFailure);
      expect(invoked).toBe(false);
    }
    return yield* Effect.void;
  }),
);

it.effect('rejects missing, extra, reordered or changed Catalog observations at final validation #1225', () =>
  Effect.gen(function* rejectsBrokenCatalogObservations() {
    const typed = completeCatalogFixture1225();
    const rawSources = typed.sources.flatMap((source) => ('sourceEvidence' in source ? [source.sourceEvidence] : []));
    for (const fault of ['MISSING', 'EXTRA', 'REORDERED', 'CHANGED'] as const) {
      const failure = yield* verifyPricingMaterialEvidenceOwnerFence(typed.candidateRef, rawSources, typed).pipe(
        Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, {
          verifyImmediatelyBeforePublication: (request) => {
            const observations = request.sources.map((source) => observationFor(source, '2026-09-28T10:00:01.500Z'));
            const [first] = observations;
            let altered: typeof observations;
            if (fault === 'MISSING') {
              altered = observations.slice(1);
            } else if (fault === 'EXTRA' && first !== undefined) {
              altered = [...observations, first];
            } else if (fault === 'REORDERED') {
              altered = [...observations].toReversed();
            } else {
              altered = observations.map((observation, index) =>
                index === 0 ? { ...observation, currentOwnerSetRevisionRef: 'changed:1225' } : observation,
              );
            }
            return Effect.succeed({
              fenceRef: 'test:1225:broken',
              observedAt: '2026-09-28T10:00:02.000Z',
              sources: altered,
            });
          },
        }),
        Effect.flip,
      );
      expect(failure.retryable).toBe(true);
    }
  }),
);

it.effect('keeps mixed-owner raw proof collisions blocked with validated Catalog multiplicity #1225', () =>
  Effect.gen(function* rejectsMixedOwnerWithTypedCatalog() {
    const typed = completeCatalogFixture1225();
    const rawSources = typed.sources.flatMap((source) => ('sourceEvidence' in source ? [source.sourceEvidence] : []));
    const [first] = rawSources;
    if (first === undefined) {
      return yield* Effect.die('TEST fixture requires Catalog evidence');
    }
    const other = sourceFor(
      'commerce.market-catalog',
      'COMMERCIAL_CONTEXT',
      '2026-09-28T12:00:00.500Z',
      '1225-collision',
    );
    const colliding = yield* Schema.decodeEffect(PricingSourceEvidenceVerifiedPresentSchema)({
      ...other,
      completeness: { ...other.completeness, verification: first.completeness.verification },
    });
    let invoked = false;
    const failure = yield* verifyPricingMaterialEvidenceOwnerFence(
      typed.candidateRef,
      [...rawSources, colliding],
      typed,
    ).pipe(
      Effect.provideService(PricingMaterialEvidenceOwnerFinalFence, {
        verifyImmediatelyBeforePublication: () => {
          invoked = true;
          return Effect.die('Cross-owner collision must fail before replay');
        },
      }),
      Effect.flip,
    );
    expect(failure).toMatchObject({
      reason:
        'Final owner fence cannot accept conflicting material proofs that reuse one opaque source-proof reference',
      retryable: true,
    });
    expect(invoked).toBe(false);
    return yield* Effect.void;
  }),
);
