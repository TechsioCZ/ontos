import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingContractualDiscountSetPredicateSchema,
  pricingContractualDiscountSetPredicateRef,
} from '../../src/domain/contractual-discount-set.ts';
import {
  PricingCommercialFeeOwnerReadReceiptSchema,
  PricingDiscountOwnerReadReceiptSchema,
  PricingExactPriceOwnerReadReceiptSchema,
  PricingMarketSourceReceiptSchema,
  PricingOwnerMaterialEvidenceFenceGatewayRequestSchema,
  PricingRetainedExternalOwnerEvidenceSchema,
  PricingRetainedPromotionEvidenceSchema,
  PricingTierOwnerReadReceiptSchema,
  PricingZeroFloorOwnerReadReceiptSchema,
} from '../../src/domain/material-evidence.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const effectiveAt = '2026-09-28T10:00:00.000Z';
const requestedAt = '2026-09-28T09:59:59.000Z';
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
    assessedAt: ownerObservedAt,
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
      observedAt: ownerObservedAt,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      variant: { resourceRef: variantRef, revision: 2 },
    },
    purpose: 'PRICING',
    selection,
    status: 'VALID',
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
    requestedAt,
  };
  const requestBase = { effectiveAt, family, ownerScope, requestedAt };
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

const persistentOwnerReadReceipt = (source: ReturnType<typeof verifiedSource>) => ({
  authority: {
    generation: 1,
    nextApplicabilityBoundary: source.completeness.temporal.nextMaterialBoundary,
    observedAt: source.completeness.temporal.observedAt,
    ownerRevision: source.completeness.ownerSetRevisionRef,
    ownerRootRef: source.completeness.ownerScope.ownerRootRef,
    predicateRef: source.completeness.ownerScope.predicateRef,
    verificationRef: source.completeness.verification.verificationRef,
  },
  factProofs: source.currentFacts.map(({ factRef, factRevisionRef, verification }) => ({
    factRef,
    factRevisionRef,
    verificationRef: verification.verificationRef,
  })),
});

const marketSourceEvidence = verifiedSource(
  'commerce.market-catalog',
  'COMMERCIAL_CONTEXT',
  'market:cz-launch:B2C:sle-a',
);
const marketSource = {
  sourceEvidence: marketSourceEvidence,
  verificationMaterial: {
    commercialScope: decision.commercialScope,
    kind: 'MARKET_CONTEXT_AUTHORITY' as const,
    receipt: Schema.decodeUnknownSync(PricingMarketSourceReceiptSchema)({
      authority: {
        generation: 1,
        nextApplicabilityBoundary: marketSourceEvidence.completeness.temporal.nextMaterialBoundary,
        observedAt: marketSourceEvidence.completeness.temporal.observedAt,
        ownerRootRef: marketSourceEvidence.completeness.ownerScope.ownerRootRef,
        ownerSetRevisionRef: marketSourceEvidence.completeness.ownerSetRevisionRef,
        predicateRef: marketSourceEvidence.completeness.ownerScope.predicateRef,
        verificationRef: marketSourceEvidence.completeness.verification.verificationRef,
      },
      currentFacts: marketSourceEvidence.currentFacts.map(
        ({ effectivePeriod, factRef, factRevisionRef, verification }) => ({
          effectivePeriod:
            effectivePeriod.effectiveTo === null
              ? { startsAt: effectivePeriod.effectiveFrom }
              : { endsAt: effectivePeriod.effectiveTo, startsAt: effectivePeriod.effectiveFrom },
          factRef,
          factRevisionRef,
          verificationRef: verification.verificationRef,
        }),
      ),
      state: 'PRESENT' as const,
    }),
  },
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
    observedAt: catalog.evidence.assessedAt,
    ownerRevision: catalog.ownerRevision,
    status: 'CURRENT' as const,
    validUntil: catalog.completeness.nextApplicabilityBoundary,
  },
  currentnessEvidence: {
    effectiveAt: compatibilityRequest.effectiveAt,
    generation: catalog.ownerRevision,
    observedAt: catalog.evidence.assessedAt,
    predicateRef: catalog.completeness.scope.predicateRef,
    revalidatedAt: catalog.evidence.assessedAt,
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
  observedAt: catalog.evidence.assessedAt,
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
    issuedAt: catalog.evidence.assessedAt,
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
const priceSourceEvidence = verifiedSource('commerce.pricing', 'PRICE', 'price:exact-selection-a', 'CZK');
const priceSource = {
  sourceEvidence: priceSourceEvidence,
  verificationMaterial: {
    kind: 'PRICING_PRICE_AUTHORITY' as const,
    lookupRequest: {
      effectiveAt,
      exactKey: {
        catalogSelection: selection,
        commercialScope: decision.commercialScope,
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'NO_GROUP' as const },
        unitBasis: line.pricingBasis,
      },
    },
    ownerReadReceipt: {
      ...persistentOwnerReadReceipt(priceSourceEvidence),
      authority: {
        ...persistentOwnerReadReceipt(priceSourceEvidence).authority,
        kind: 'PERSISTENT' as const,
      },
    },
  },
};
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const discountPredicate = Schema.decodeUnknownSync(PricingContractualDiscountSetPredicateSchema)({
  audiences: [{ kind: 'PRICE_GROUP' as const, priceGroupRef }],
  basis: {
    catalogSelection: line.catalog.selection,
    kind: 'VARIANT_LINE' as const,
    unitBasis: line.pricingBasis,
  },
  commercialScope: decision.commercialScope,
  currencyCode: decision.currencyCode,
  effectiveAt,
  tenantId,
});
const discountPredicateRef = pricingContractualDiscountSetPredicateRef(discountPredicate);
const discountSourceEvidence = verifiedSource('commerce.pricing', 'DISCOUNT', discountPredicateRef, 'CZK');
const discountOwnerReadReceipt = {
  authority: {
    generation: 7,
    observedAt: discountSourceEvidence.completeness.temporal.observedAt,
    ownerRevision: discountSourceEvidence.completeness.ownerSetRevisionRef,
    ownerRootRef: discountSourceEvidence.completeness.ownerScope.ownerRootRef,
    predicateRef: discountPredicateRef,
    verificationRef: discountSourceEvidence.completeness.verification.verificationRef,
    verifiedAt: discountSourceEvidence.completeness.temporal.observedAt,
  },
  completenessEvidence: discountSourceEvidence.completeness.completenessEvidence,
  factProofs: discountSourceEvidence.currentFacts.map(({ factRef, factRevisionRef, verification }) => ({
    factRef,
    factRevisionRef,
    verificationRef: verification.verificationRef,
  })),
  predicate: discountPredicate,
};
const discountSource = {
  sourceEvidence: discountSourceEvidence,
  verificationMaterial: {
    applicabilityBindings: [],
    identityKeys: [
      {
        audience: discountPredicate.audiences[0],
        basis: discountPredicate.basis,
        commercialScope: discountPredicate.commercialScope,
        currencyCode: discountPredicate.currencyCode,
        effectKind: 'FIXED_MONETARY_AMOUNT' as const,
        family: 'CONTRACTUAL_DISCOUNT' as const,
        monetaryBoundary: 'PRE_TAX' as const,
        scope: 'VARIANT_LINE' as const,
      },
    ],
    kind: 'PRICING_DISCOUNT_AUTHORITY' as const,
    ownerReadReceipt: discountOwnerReadReceipt,
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
const request = {
  candidateRef: 'candidate:a',
  decision,
  effectiveAt,
  evaluatedAt,
  requestedAt,
  sources: [catalogSource, marketSource, priceSource, purchaseAuthoritySource],
  subject: guestSubject,
};

const decode = Schema.decodeUnknownSync(PricingOwnerMaterialEvidenceFenceGatewayRequestSchema, {
  onExcessProperty: 'error',
});
const decodeExternalEvidence = Schema.decodeUnknownSync(PricingRetainedExternalOwnerEvidenceSchema, {
  onExcessProperty: 'error',
});

describe('Pricing owner material-evidence final-fence request', () => {
  it('distinguishes an unselected Promotion path from selected owner evidence', () => {
    const decodePromotion = Schema.decodeUnknownSync(PricingRetainedPromotionEvidenceSchema, {
      onExcessProperty: 'error',
    });
    const notSelected = { kind: 'PROMOTION_NOT_SELECTED' } as const;
    const selected = {
      kind: 'PROMOTION_SELECTED',
      sourceEvidence: verifiedSource('commerce.promotion', 'PROMOTION', 'promotion:application:a'),
    } as const;

    expect(decodePromotion(notSelected)).toEqual(notSelected);
    expect(decodePromotion(selected)).toEqual(selected);
    expect(() => decodePromotion({ ...notSelected, sourceEvidence: selected.sourceEvidence })).toThrow();
    expect(() => decodePromotion({ kind: 'PROMOTION_SELECTED' })).toThrow();
  });

  it('retains exact Catalog handoff, Market context, and Pricing exact-key authority', () => {
    expect(decode(request)).toEqual(request);
  });

  it('requires the exact proof-bearing Catalog Quantity compatibility replay', () => {
    const { compatibilityRequest: _request, ...withoutRequest } = catalogSource.verificationMaterial;
    expect(() =>
      decode({
        ...request,
        sources: [{ ...catalogSource, verificationMaterial: withoutRequest }, purchaseAuthoritySource],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...request,
        sources: [
          {
            ...catalogSource,
            verificationMaterial: {
              ...catalogSource.verificationMaterial,
              compatibilityResponse: {
                effectiveAt: compatibilityRequest.effectiveAt,
                outcome: 'UNAVAILABLE',
                reason: 'owner unavailable',
                retryable: true,
              },
            },
          },
          purchaseAuthoritySource,
        ],
      }),
    ).toThrow();
  });

  it('retains Purchase Context as an exact singleton proof without fabricated set completeness', () => {
    expect(decode(request).sources.at(-1)).toEqual(purchaseAuthoritySource);
    expect(() => decode({ ...request, sources: request.sources.slice(0, -1) })).toThrow();
    expect(() =>
      decode({
        ...request,
        sources: [
          ...request.sources.slice(0, -1),
          {
            ...purchaseAuthoritySource,
            sourceEvidence: verifiedSource(
              'commerce.customer-context',
              'COMMERCIAL_CONTEXT',
              'fabricated:purchase-set-predicate',
            ),
          },
        ],
      }),
    ).toThrow();
  });

  it('retains Price Group evidence only for Profile subjects', () => {
    const guestEvidence = {
      candidateRef: request.candidateRef,
      catalogSelections: [{ occurrenceId: line.occurrenceId, sourceEvidence: catalogSource.sourceEvidence }],
      decision,
      market: marketSource.sourceEvidence,
      promotion: { kind: 'PROMOTION_NOT_SELECTED' as const },
      requestedAt,
      subject: guestSubject,
      validatedAt: evaluatedAt,
    };
    expect(decodeExternalEvidence(guestEvidence)).toEqual(guestEvidence);

    const priceGroupAssignment = verifiedSource(
      'commerce.customer-context',
      'COMMERCIAL_CONTEXT',
      'customer-context:price-group:profile-a',
    );
    expect(() => decodeExternalEvidence({ ...guestEvidence, priceGroupAssignment })).toThrow();

    const profileSubject = {
      authorizationSubject: { kind: 'RETAIL' as const },
      kind: 'PROFILE' as const,
      profileRef: {
        moduleId: 'commerce.customer-context' as const,
        resourceId: '88888888-8888-4888-8888-888888888888',
        resourceType: 'commerce.customer-context.retail-customer-profile' as const,
        tenantId,
      },
    };
    expect(() => decodeExternalEvidence({ ...guestEvidence, subject: profileSubject })).toThrow();
    expect(decodeExternalEvidence({ ...guestEvidence, priceGroupAssignment, subject: profileSubject })).toEqual({
      ...guestEvidence,
      priceGroupAssignment,
      subject: profileSubject,
    });
  });

  it('rejects missing or substituted exact Price owner read receipts', () => {
    const { ownerReadReceipt: _omitted, ...withoutOwnerReadReceipt } = priceSource.verificationMaterial;
    expect(() =>
      decode({
        ...request,
        sources: [{ ...priceSource, verificationMaterial: withoutOwnerReadReceipt }],
      }),
    ).toThrow();

    expect(() =>
      decode({
        ...request,
        sources: [
          {
            ...priceSource,
            verificationMaterial: {
              ...priceSource.verificationMaterial,
              ownerReadReceipt: {
                ...priceSource.verificationMaterial.ownerReadReceipt,
                authority: {
                  ...priceSource.verificationMaterial.ownerReadReceipt.authority,
                  verificationRef: 'opaque:commerce.pricing:substituted-set-proof',
                },
              },
            },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      decode({
        ...request,
        sources: [
          {
            ...priceSource,
            verificationMaterial: {
              ...priceSource.verificationMaterial,
              ownerReadReceipt: {
                ...priceSource.verificationMaterial.ownerReadReceipt,
                factProofs: priceSource.verificationMaterial.ownerReadReceipt.factProofs.map((proof) => ({
                  ...proof,
                  verificationRef: 'opaque:commerce.pricing:substituted-fact-proof',
                })),
              },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('retains Discount Current-set authority separately from applicability predicates', () => {
    const decodeReceipt = Schema.decodeUnknownSync(PricingDiscountOwnerReadReceiptSchema, {
      onExcessProperty: 'error',
    });
    expect(decodeReceipt(discountOwnerReadReceipt)).toEqual(discountOwnerReadReceipt);
    expect(decode({ ...request, sources: [discountSource, purchaseAuthoritySource] }).sources[0]).toEqual(
      discountSource,
    );

    const { ownerReadReceipt: _receipt, ...withoutReceipt } = discountSource.verificationMaterial;
    expect(() =>
      decode({
        ...request,
        sources: [{ ...discountSource, verificationMaterial: withoutReceipt }, purchaseAuthoritySource],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...request,
        sources: [
          {
            ...discountSource,
            verificationMaterial: {
              ...discountSource.verificationMaterial,
              ownerReadReceipt: {
                ...discountOwnerReadReceipt,
                authority: { ...discountOwnerReadReceipt.authority, predicateRef: 'discount:applicability-only' },
              },
            },
          },
          purchaseAuthoritySource,
        ],
      }),
    ).toThrow();
  });

  it('accepts an authoritative empty Discount set only with empty facts and identities', () => {
    const emptySourceEvidence = {
      _tag: 'VERIFIED_ABSENT' as const,
      completeness: discountSourceEvidence.completeness,
      request: discountSourceEvidence.request,
    };
    const emptyOwnerReadReceipt = { ...discountOwnerReadReceipt, factProofs: [] };
    const emptyDiscountSource = {
      sourceEvidence: emptySourceEvidence,
      verificationMaterial: {
        ...discountSource.verificationMaterial,
        identityKeys: [],
        ownerReadReceipt: emptyOwnerReadReceipt,
      },
    };

    expect(decode({ ...request, sources: [emptyDiscountSource, purchaseAuthoritySource] }).sources[0]).toEqual(
      emptyDiscountSource,
    );
    expect(() =>
      decode({
        ...request,
        sources: [
          {
            ...emptyDiscountSource,
            verificationMaterial: {
              ...emptyDiscountSource.verificationMaterial,
              identityKeys: discountSource.verificationMaterial.identityKeys,
            },
          },
          purchaseAuthoritySource,
        ],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...request,
        sources: [
          {
            ...discountSource,
            verificationMaterial: { ...discountSource.verificationMaterial, identityKeys: [] },
          },
          purchaseAuthoritySource,
        ],
      }),
    ).toThrow();
  });

  it('requires complete owner-issued authority and fact proofs for every Pricing owner receipt class', () => {
    const persistentReceipt = persistentOwnerReadReceipt(priceSource.sourceEvidence);
    const exactPriceReceipt = priceSource.verificationMaterial.ownerReadReceipt;
    const receiptSchemas = [
      [PricingExactPriceOwnerReadReceiptSchema, exactPriceReceipt],
      [PricingTierOwnerReadReceiptSchema, persistentReceipt],
      [PricingCommercialFeeOwnerReadReceiptSchema, persistentReceipt],
      [PricingZeroFloorOwnerReadReceiptSchema, persistentReceipt],
    ] as const;

    for (const [schema, receipt] of receiptSchemas) {
      const decodeReceipt = Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' });
      expect(decodeReceipt(receipt)).toEqual(receipt);
      expect(() => decodeReceipt({ authority: receipt.authority })).toThrow();
      const { verificationRef: _omitted, ...authorityWithoutVerification } = receipt.authority;
      expect(() => decodeReceipt({ ...receipt, authority: authorityWithoutVerification })).toThrow();
    }
  });

  it('rejects the old lossy opaque-reference-only fence source shape', () => {
    expect(() =>
      decode({
        ...request,
        sources: [
          {
            currentFacts: marketSource.sourceEvidence.currentFacts,
            evidenceVerificationRef: marketSource.sourceEvidence.completeness.verification.verificationRef,
            family: 'COMMERCIAL_CONTEXT',
            ownerModuleId: 'commerce.market-catalog',
            ownerRootRef: marketSource.sourceEvidence.request.ownerScope.ownerRootRef,
            ownerSetRevisionRef: marketSource.sourceEvidence.completeness.ownerSetRevisionRef,
            predicateRef: marketSource.sourceEvidence.request.ownerScope.predicateRef,
            tenantId,
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects authority material for another candidate decision or owner evaluation interval', () => {
    expect(() =>
      decode({
        ...request,
        sources: [
          {
            ...marketSource,
            verificationMaterial: {
              ...marketSource.verificationMaterial,
              commercialScope: { ...decision.commercialScope, marketId: 'market-other' },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() => decode({ ...request, evaluatedAt: ownerEvaluatedAt })).toThrow();
  });

  it('rejects an exact Price predicate with the right selection but a different quantity or unit', () => {
    expect(() =>
      decode({
        ...request,
        sources: [
          {
            ...priceSource,
            verificationMaterial: {
              ...priceSource.verificationMaterial,
              lookupRequest: {
                ...priceSource.verificationMaterial.lookupRequest,
                exactKey: {
                  ...priceSource.verificationMaterial.lookupRequest.exactKey,
                  unitBasis: { ...line.pricingBasis, quantity: '2' },
                },
              },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('keeps currency generic without introducing Storefront or FX material', () => {
    const eurDecision = {
      ...decision,
      currencyCode: 'EUR',
      purchasingContext: {
        ...decision.purchasingContext,
        currencyResolution: { ...decision.purchasingContext.currencyResolution, currencyCode: 'EUR' },
      },
    } as const;
    const eurSourceEvidence = verifiedSource('commerce.pricing', 'PRICE', 'price:exact-selection-a:EUR', 'EUR');
    const eurPrice = {
      sourceEvidence: eurSourceEvidence,
      verificationMaterial: {
        ...priceSource.verificationMaterial,
        lookupRequest: {
          ...priceSource.verificationMaterial.lookupRequest,
          exactKey: { ...priceSource.verificationMaterial.lookupRequest.exactKey, currencyCode: 'EUR' },
        },
        ownerReadReceipt: {
          ...persistentOwnerReadReceipt(eurSourceEvidence),
          authority: {
            ...persistentOwnerReadReceipt(eurSourceEvidence).authority,
            kind: 'PERSISTENT' as const,
          },
        },
      },
    };

    expect(
      decode({
        candidateRef: request.candidateRef,
        decision: eurDecision,
        effectiveAt,
        evaluatedAt,
        requestedAt,
        sources: [eurPrice, purchaseAuthoritySource],
        subject: request.subject,
      }).decision.currencyCode,
    ).toBe('EUR');
  });
});
