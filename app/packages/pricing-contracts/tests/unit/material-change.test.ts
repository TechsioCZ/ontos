import {
  PricingCurrentnessEvaluationOutcomeSchema,
  PricingFreshAttemptOutcomeSchema,
  PricingIndeterminateOrUnverifiableOutcomeSchema,
  PricingKnownInvalidOrConflictOutcomeSchema,
  PricingKnownStaleOrMaterialChangedOutcomeSchema,
  PricingMaterialChangeAssessmentRequestSchema,
  PricingMaterialChangeClassificationSchema,
  PricingMaterialChangedSchema,
  PricingMaterialOwnerTransitionEvidenceSchema,
  PricingMaterialStateSnapshotSchema,
  PricingNonMaterialSchema,
  PricingOwnerConfirmedNonMaterialSchema,
  PricingRetryExhaustedOutcomeSchema,
} from '@app/pricing-contracts/domain/material-change';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const tenantId = '20000000-0000-4000-8000-000000000001';
const operationTime = '2026-09-28T10:00:00.000Z';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
};
const selection = { productRef, variantRef };
const catalogEvidence = {
  assessedAt: '2026-09-28T09:59:59.000Z',
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
    attestationId: '12121212-1212-4212-8212-121212121212',
    observedAt: '2026-09-28T09:59:59.000Z',
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection,
  status: 'VALID' as const,
};
const catalog = {
  completeness: {
    observedAt: '2026-09-28T09:59:59.000Z',
    ownerRevision: 'catalog-quantity:17',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
  },
  divisible: false,
  equivalentSelectionKey: 'catalog-selection:exact',
  evidence: catalogEvidence,
  hierarchyRevision: 'catalog-hierarchy:9',
  ownerRevision: 'catalog-quantity:17',
  quantity: {
    changed: false,
    notice: null,
    requested: '1',
    resulting: '1',
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
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
  status: 'READY' as const,
  unitRef,
};

const decisionFor = (currencyCode: string) => ({
  commercialScope: {
    channelId: 'B2C' as const,
    marketId: 'market-cz',
    sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
  },
  currencyCode,
  lines: [{ catalog, occurrenceId: 'line-a', pricingBasis: { quantity: '1', unitRef } }],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:1',
      decisionRevision: 'purchase-access-decision:r1',
    },
    actor: { kind: 'PRINCIPAL' as const, principalId: 'pricing-principal:1' },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:1',
      decisionRevision: 'purchase-commercial-settings:r1',
    },
    contextRef: 'purchase-1',
    contextRevision: 'purchase-r1',
    currencyResolution: {
      currencyCode,
      resolutionRef: 'purchase-currency-resolution:1',
      resolutionRevision: 'purchase-currency-resolution:r1',
    },
    subject: {
      authorizationSubject: { kind: 'RETAIL' as const },
      kind: 'PROFILE' as const,
      profileRef: {
        moduleId: 'commerce.customer-context' as const,
        resourceId: 'purchase-1',
        resourceType: 'commerce.customer-context.retail-customer-profile' as const,
        tenantId,
      },
    },
  },
  tenantId,
});

const ownerScope = {
  ownerModuleId: 'commerce.pricing',
  ownerRootRef: 'pricing:price-root:tenant-1',
  predicateRef: 'price:variant-1:sle-1:B2C:market-cz:currency:exact',
  tenantId,
};

const evidenceFor = ({
  currencyCode = 'CZK',
  evaluatedAt,
  observedAt,
  requestedAt,
  revision,
}: {
  currencyCode?: string;
  evaluatedAt: string;
  observedAt: string;
  requestedAt: string;
  revision: string;
}) => {
  const temporal = {
    effectiveAt: operationTime,
    evaluatedAt,
    evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
    nextMaterialBoundary: '2026-09-28T11:00:00.000Z',
    observedAt,
    requestedAt,
  };
  const request = {
    currencyCode,
    effectiveAt: operationTime,
    family: 'PRICE' as const,
    ownerScope,
    requestedAt,
  };
  return {
    _tag: 'VERIFIED_PRESENT' as const,
    completeness: {
      completenessEvidence: {
        nextApplicabilityBoundary: temporal.nextMaterialBoundary,
        observedAt,
        ownerRevision: `price-set:${revision}`,
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: ownerScope.predicateRef },
      },
      currencyCode,
      family: 'PRICE' as const,
      ownerScope,
      ownerSetRevisionRef: `price-set:${revision}`,
      temporal,
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
        verificationRef: `proof:price-set:${revision}`,
      },
    },
    currentFacts: [
      {
        currencyCode,
        effectivePeriod: {
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          effectiveTo: '2026-10-01T00:00:00.000Z',
        },
        factRef: 'price:variant-1',
        factRevisionRef: `price-revision:${revision}`,
        family: 'PRICE' as const,
        ownerScope,
        temporal,
        verification: {
          kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
          verificationRef: `proof:price-revision:${revision}`,
        },
      },
    ],
    request,
  };
};

const snapshotFor = ({
  attemptId,
  capturedAt,
  currencyCode = 'CZK',
  evaluatedAt,
  observedAt,
  requestedAt,
  revision,
  snapshotId,
}: {
  attemptId: string;
  capturedAt: string;
  currencyCode?: string;
  evaluatedAt: string;
  observedAt: string;
  requestedAt: string;
  revision: string;
  snapshotId: string;
}) => ({
  attemptId,
  calculationVersions: {
    allocationContractVersions: ['allocation-v1'],
    arithmeticProfileVersions: ['arithmetic-v1'],
    publicationProfileVersions: ['publication-v1'],
  },
  candidateRef: 'candidate-787',
  capturedAt,
  decision: decisionFor(currencyCode),
  materialBindings: [
    {
      bindingRef: 'binding:price:line-a',
      kind: 'EXACT_PRICE_SET' as const,
      meaningRef: `meaning:price:${revision}`,
      sourceEvidence: evidenceFor({ currencyCode, evaluatedAt, observedAt, requestedAt, revision }),
    },
  ],
  nonMaterialObservations: [
    { kind: 'STOREFRONT_ORIGIN' as const, observationRef: 'storefront:brand-a' },
    { kind: 'TAX_ONLY' as const, observationRef: 'tax:revision-9' },
  ],
  requestedAt,
  snapshotId,
});

const firstSnapshot = snapshotFor({
  attemptId: 'attempt-1',
  capturedAt: '2026-09-28T10:00:00.400Z',
  evaluatedAt: '2026-09-28T10:00:00.200Z',
  observedAt: '2026-09-28T10:00:00.300Z',
  requestedAt: '2026-09-28T10:00:00.100Z',
  revision: '1',
  snapshotId: 'snapshot-1',
});
const secondSnapshot = snapshotFor({
  attemptId: 'attempt-2',
  capturedAt: '2026-09-28T10:00:01.000Z',
  evaluatedAt: '2026-09-28T10:00:00.800Z',
  observedAt: '2026-09-28T10:00:00.900Z',
  requestedAt: '2026-09-28T10:00:00.700Z',
  revision: '2',
  snapshotId: 'snapshot-2',
});

const attemptFor = (snapshot: typeof firstSnapshot, attemptOrdinal: 1 | 2) => ({
  attemptId: snapshot.attemptId,
  attemptOrdinal,
  candidateRef: snapshot.candidateRef,
  completedAt: attemptOrdinal === 1 ? '2026-09-28T10:00:00.500Z' : '2026-09-28T10:00:01.100Z',
  maxAttempts: 2 as const,
  runId: 'evaluation-run-787',
  snapshot,
  startedAt: attemptOrdinal === 1 ? '2026-09-28T10:00:00.000Z' : '2026-09-28T10:00:00.600Z',
});

const decodeSnapshot = Schema.decodeUnknownSync(PricingMaterialStateSnapshotSchema, { onExcessProperty: 'error' });
const decodeTransition = Schema.decodeUnknownSync(PricingMaterialOwnerTransitionEvidenceSchema, {
  onExcessProperty: 'error',
});
const decodeAssessment = Schema.decodeUnknownSync(PricingMaterialChangeAssessmentRequestSchema, {
  onExcessProperty: 'error',
});
const decodeClassification = Schema.decodeUnknownSync(PricingMaterialChangeClassificationSchema, {
  onExcessProperty: 'error',
});
const decodeOutcome = Schema.decodeUnknownSync(PricingCurrentnessEvaluationOutcomeSchema, {
  onExcessProperty: 'error',
});

describe('Pricing material change and bounded retry contracts', () => {
  it('retains exact owner proofs and actual latency in one coherent snapshot', () => {
    const snapshot = decodeSnapshot(firstSnapshot);
    expect(Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(snapshot.materialBindings[0]?.sourceEvidence)).toBe(
      true,
    );
    expect(snapshot.materialBindings[0]?.sourceEvidence).toEqual(firstSnapshot.materialBindings[0]?.sourceEvidence);
    expect(snapshot.requestedAt).toBe('2026-09-28T10:00:00.100Z');
    expect(snapshot.capturedAt).toBe('2026-09-28T10:00:00.400Z');

    expect(() => decodeSnapshot({ ...firstSnapshot, capturedAt: '2026-09-28T10:00:00.250Z' })).toThrow();
    expect(() =>
      decodeSnapshot({
        ...firstSnapshot,
        materialBindings: [firstSnapshot.materialBindings[0], firstSnapshot.materialBindings[0]],
      }),
    ).toThrow();
  });

  it('keeps the currency schema generalized without activating FX or a second Launch currency', () => {
    const eur = decodeSnapshot(
      snapshotFor({
        attemptId: 'attempt-eur',
        capturedAt: '2026-09-28T10:00:00.400Z',
        currencyCode: 'EUR',
        evaluatedAt: '2026-09-28T10:00:00.200Z',
        observedAt: '2026-09-28T10:00:00.300Z',
        requestedAt: '2026-09-28T10:00:00.100Z',
        revision: 'eur-1',
        snapshotId: 'snapshot-eur',
      }),
    );
    expect(eur.decision.currencyCode).toBe('EUR');
    expect(eur).not.toHaveProperty('exchangeRate');
    expect(eur).not.toHaveProperty('convertedCurrency');
  });

  it('requires owner-issued proof for a changed-evidence non-material transition', () => {
    const transition = {
      bindingRef: 'binding:price:line-a',
      confirmedAt: '2026-09-28T10:00:01.200Z',
      currentEvidence: secondSnapshot.materialBindings[0]?.sourceEvidence,
      currentSnapshotId: secondSnapshot.snapshotId,
      family: 'PRICE' as const,
      ownerScope,
      previousEvidence: firstSnapshot.materialBindings[0]?.sourceEvidence,
      previousSnapshotId: firstSnapshot.snapshotId,
      transitionRef: 'owner-transition:price:1-to-2',
      verification: {
        kind: 'OWNER_CONFIRMED_NON_MATERIAL_TRANSITION' as const,
        verificationRef: 'owner-proof:price:1-to-2',
      },
    };

    expect(decodeTransition(transition).bindingRef).toBe('binding:price:line-a');
    expect(
      decodeAssessment({ current: secondSnapshot, ownerTransitions: [transition], previous: firstSnapshot }),
    ).toBeDefined();
    expect(() =>
      decodeTransition({ ...transition, ownerScope: { ...ownerScope, predicateRef: 'unrelated' } }),
    ).toThrow();
    expect(() =>
      decodeAssessment({
        current: secondSnapshot,
        ownerTransitions: [{ ...transition, bindingRef: 'other' }],
        previous: firstSnapshot,
      }),
    ).toThrow();
    expect(() => {
      const { verification: _verification, ...withoutOwnerProof } = transition;
      return decodeTransition(withoutOwnerProof);
    }).toThrow();
  });

  it('distinguishes material, owner-confirmed, exact-state, storefront/tax-only, and unverifiable classifications', () => {
    const transition = decodeTransition({
      bindingRef: 'binding:price:line-a',
      confirmedAt: '2026-09-28T10:00:01.200Z',
      currentEvidence: secondSnapshot.materialBindings[0]?.sourceEvidence,
      currentSnapshotId: secondSnapshot.snapshotId,
      family: 'PRICE',
      ownerScope,
      previousEvidence: firstSnapshot.materialBindings[0]?.sourceEvidence,
      previousSnapshotId: firstSnapshot.snapshotId,
      transitionRef: 'owner-transition:price:1-to-2',
      verification: {
        kind: 'OWNER_CONFIRMED_NON_MATERIAL_TRANSITION',
        verificationRef: 'owner-proof:price:1-to-2',
      },
    });
    const classifications = [
      {
        _tag: 'MATERIAL_CHANGED',
        currentSnapshotId: 'snapshot-2',
        previousSnapshotId: 'snapshot-1',
        reasons: ['PRICE_SCHEDULE_BOUNDARY_CROSSED'],
      },
      {
        _tag: 'OWNER_CONFIRMED_NON_MATERIAL',
        currentSnapshotId: 'snapshot-2',
        previousSnapshotId: 'snapshot-1',
        transitions: [transition],
      },
      {
        _tag: 'NON_MATERIAL',
        currentSnapshotId: 'snapshot-2',
        previousSnapshotId: 'snapshot-1',
        reason: 'EXACT_MATERIAL_STATE',
      },
      {
        _tag: 'NON_MATERIAL',
        currentSnapshotId: 'snapshot-2',
        previousSnapshotId: 'snapshot-1',
        reason: 'STOREFRONT_OR_TAX_ONLY',
      },
      {
        _tag: 'UNVERIFIABLE',
        currentSnapshotId: 'snapshot-2',
        previousSnapshotId: 'snapshot-1',
        reasons: ['Owner proof could not be verified'],
      },
    ];
    const decoded = classifications.map((value) => decodeClassification(value));
    expect(Schema.is(PricingMaterialChangedSchema)(decoded[0])).toBe(true);
    expect(Schema.is(PricingOwnerConfirmedNonMaterialSchema)(decoded[1])).toBe(true);
    expect(Schema.is(PricingNonMaterialSchema)(decoded[2])).toBe(true);
    expect(Schema.is(PricingNonMaterialSchema)(decoded[3])).toBe(true);
    expect(Schema.is(PricingMaterialChangeClassificationSchema)(decoded[4])).toBe(true);
    expect(() =>
      decodeClassification({
        _tag: 'OWNER_CONFIRMED_NON_MATERIAL',
        currentSnapshotId: 'snapshot-2',
        previousSnapshotId: 'snapshot-1',
        transitions: [],
      }),
    ).toThrow();
  });

  it('keeps outcomes distinct and exhausts only after two whole, non-merged attempts', () => {
    const firstAttempt = attemptFor(firstSnapshot, 1);
    const finalAttempt = attemptFor(secondSnapshot, 2);
    const material = {
      _tag: 'MATERIAL_CHANGED' as const,
      currentSnapshotId: 'snapshot-1',
      previousSnapshotId: 'snapshot-before',
      reasons: ['EXACT_PRICE_KEY_OR_SET_CHANGED' as const],
    };

    expect(
      Schema.is(PricingFreshAttemptOutcomeSchema)(
        decodeOutcome({ _tag: 'FRESH', attempt: finalAttempt, retryDirective: 'NONE' }),
      ),
    ).toBe(true);
    expect(
      Schema.is(PricingKnownStaleOrMaterialChangedOutcomeSchema)(
        decodeOutcome({
          _tag: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
          attempt: firstAttempt,
          classification: material,
          retryDirective: 'RETRY_WHOLE_ATTEMPT',
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(PricingKnownInvalidOrConflictOutcomeSchema)(
        decodeOutcome({
          _tag: 'KNOWN_INVALID_OR_CONFLICT',
          attempt: firstAttempt,
          reason: 'Exact-key collision',
          retryDirective: 'NONE',
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(PricingIndeterminateOrUnverifiableOutcomeSchema)(
        decodeOutcome({
          _tag: 'INDETERMINATE_OR_UNVERIFIABLE',
          attempt: firstAttempt,
          reason: 'Owner unavailable',
          retryDirective: 'RETRY_WHOLE_ATTEMPT',
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(PricingRetryExhaustedOutcomeSchema)(
        decodeOutcome({
          _tag: 'RETRY_EXHAUSTED',
          finalAttempt,
          finalFailure: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
          firstAttempt,
          firstFailure: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
          reason: 'Material state did not stabilize',
          retryDirective: 'NONE',
        }),
      ),
    ).toBe(true);

    expect(() =>
      decodeOutcome({
        _tag: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
        attempt: finalAttempt,
        classification: { ...material, currentSnapshotId: 'snapshot-2' },
        retryDirective: 'RETRY_WHOLE_ATTEMPT',
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        _tag: 'RETRY_EXHAUSTED',
        finalAttempt: { ...finalAttempt, snapshot: { ...secondSnapshot, snapshotId: 'snapshot-1' } },
        finalFailure: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
        firstAttempt,
        firstFailure: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
        reason: 'Material state did not stabilize',
        retryDirective: 'NONE',
      }),
    ).toThrow();
  });
});
