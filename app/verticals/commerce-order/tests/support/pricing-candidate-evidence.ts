/**
 * Pricing's issued Quotations of the Order unit's final Cart candidate and of another candidate Pricing
 * priced the same way, in the JSON wire form Pricing's owner answers them. Order owns this immutable copy
 * and only ever decodes it through the `@app/pricing-contracts` Quotation contract; nothing here runs
 * Pricing's own computation. Repeated owner values are named once and shared by reference.
 */

const commerceCatalog = 'commerce.catalog';
const resourceId = '44444444-4444-4444-8444-444444444444';
const tenantId = '11111111-1111-4111-8111-111111111111';
const commerceCustomerContext = 'commerce.customer-context';
const observedAt = '2026-09-28T12:00:00.000Z';
const ownerRevision = 'pricing:commercial-context:quotation-fixture-set-revision';
const exactPredicate = 'EXACT_PREDICATE';
const predicateRef = 'pricing:commercial-context:quotation-fixture-predicate';
const verifiedPresent = 'VERIFIED_PRESENT';
const commercialContext = 'COMMERCIAL_CONTEXT';
const ownerVerifiableOpaqueReference = 'OWNER_VERIFIABLE_OPAQUE_REFERENCE';
const verificationRef = 'pricing:commercial-context:quotation-fixture-proof';
const effectiveFrom = '2026-09-01T00:00:00.000Z';
const validUntil = '2026-10-01T00:00:00.000Z';
const catalogQuantity778 = 'catalog-quantity:778';
const predicateRef2 =
  'commerce.catalog.quantity-basis-predicate:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:1:3:33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444:7:2026-09-28T12:00:00.000Z:55555555-5555-4555-8555-555555555555:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:1:NO_TIER:NO_TIER_ENDPOINT';
const sellingLegalEntityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const promotionSelected = 'PROMOTION_SELECTED';
const candidateRef = '99999999-9999-4999-8999-999999999999';
const commercePricing = 'commerce.pricing';
const supportRootId = '88888888-8888-4888-8888-888888888888';
const observedAt2 = '2026-09-28T12:00:00.050Z';
const revalidatedAt = '2026-09-28T12:00:00.100Z';
const variantLine = 'VARIANT_LINE';
const priceRevisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fixedMonetaryAmount = 'FIXED_MONETARY_AMOUNT';
const oncePerStableLine = 'ONCE_PER_STABLE_LINE';
const discountApplicable = 'DISCOUNT_APPLICABLE';
const nonPositiveReduction = 'NON_POSITIVE_REDUCTION';
const promotionR779 = 'promotion-r779';
const promotionCandidate779 = 'promotion-candidate:779';
const pricingComposition779 = 'pricing-composition:779';
const promotionRequest779 = 'promotion-request:779';
const currencySupport4 = 'CURRENCY_SUPPORT';
const commercialFee = 'COMMERCIAL_FEE';
const quantityTier = 'QUANTITY_TIER';
const candidateRef2 = '98989898-9898-4898-8898-989898989898';

const unitRef = { moduleId: commerceCatalog, resourceId, resourceType: 'commerce.catalog.product-unit', tenantId };

const quantity = { amount: '1', unitRef };

const productRef = {
  moduleId: commerceCatalog,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
};

const variantRef = {
  moduleId: commerceCatalog,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
};

const selection = { productRef, variantRef };

const lines = [{ occurrenceId: 'line-779', quantity, selection }];

const subjectRef = {
  moduleId: commerceCustomerContext,
  resourceId,
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
};

const subject = {
  kind: 'AUTHENTICATED',
  purchaseContext: { contextRef: 'purchase-context:order-unit', contextRevision: '1' },
  subjectEvidenceRef: 'subject-evidence:order-unit',
  subjectRef,
};

const calculationVersions = {
  allocationContractVersions: ['pricing-allocation-v1'],
  arithmeticProfileVersions: ['pricing-arithmetic-v1'],
  publicationProfileVersions: ['pricing-czk-publication-v1'],
};

const completenessEvidence = { observedAt, ownerRevision, scope: { kind: exactPredicate, predicateRef } };

const ownerScope = {
  ownerModuleId: commerceCatalog,
  ownerRootRef: 'pricing:commercial-context:quotation-fixture-root',
  predicateRef,
  tenantId,
};

const temporal = {
  effectiveAt: observedAt,
  evaluatedAt: observedAt,
  evaluationMode: 'CURRENT_AT_OWNER_EVALUATION',
  observedAt,
  requestedAt: observedAt,
};

const catalogSelections = [
  {
    occurrenceId: 'line-779',
    sourceEvidence: {
      _tag: verifiedPresent,
      completeness: {
        completenessEvidence,
        currencyCode: 'CZK',
        family: commercialContext,
        ownerScope,
        ownerSetRevisionRef: ownerRevision,
        temporal,
        verification: { kind: ownerVerifiableOpaqueReference, verificationRef },
      },
      currentFacts: [
        {
          currencyCode: 'CZK',
          effectivePeriod: { effectiveFrom, effectiveTo: null },
          factRef: 'pricing:commercial-context:quotation-fixture-fact',
          factRevisionRef: 'pricing:commercial-context:quotation-fixture-revision',
          family: commercialContext,
          ownerScope,
          temporal,
          verification: { kind: ownerVerifiableOpaqueReference, verificationRef },
        },
      ],
      request: {
        currencyCode: 'CZK',
        effectiveAt: observedAt,
        family: commercialContext,
        ownerScope,
        requestedAt: observedAt,
      },
    },
  },
];

const source = { resourceRef: productRef, revision: 1 };

const source2 = { resourceRef: variantRef, revision: 2 };

const evidence = {
  assessedAt: observedAt,
  basis: [
    { role: 'PRODUCT', source },
    { role: 'VARIANT', source: source2 },
    { provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION', role: 'PRODUCT_TYPE_UNTYPED_DECISION', source },
  ],
  membership: {
    attestationId: '77777777-7777-4777-8777-777777777777',
    observedAt,
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: source2,
  },
  purpose: 'PRICING',
  selection,
  status: 'VALID',
  validUntil,
};

const completeness = {
  nextApplicabilityBoundary: validUntil,
  observedAt,
  ownerRevision: catalogQuantity778,
  scope: { kind: exactPredicate, predicateRef: predicateRef2 },
};

const quantityBasis = { targetDivisibilityRevision: 3, targetRef: variantRef, unitRef, unitRuleRevision: 7 };

const catalog = {
  completeness,
  divisible: true,
  equivalentSelectionKey: 'pricing-purpose:33333333-3333-4333-8333-333333333333',
  evidence,
  hierarchyRevision: 'catalog-hierarchy:778',
  ownerRevision: catalogQuantity778,
  quantity: {
    changed: false,
    notice: null,
    requested: '1',
    resulting: '1',
    rounding: 'HALF_UP',
    status: 'VALID',
    step: '0.000000001',
    targetId: '33333333-3333-4333-8333-333333333333',
    tenantId,
    unitId: resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis,
  selection,
  status: 'READY',
  unitRef,
};

const pricingBasis = { quantity: '1', unitRef };

const linesItem0 = { catalog, occurrenceId: 'line-779', pricingBasis };

const decision = {
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
  currencyCode: 'CZK',
  lines: [linesItem0],
  monetaryBoundary: 'PRE_TAX',
  operationTime: observedAt,
  purchasingContext: {
    accessDecision: { decisionRef: 'access:order-unit', decisionRevision: '1' },
    actor: { kind: 'PRINCIPAL', principalId: '12121212-1212-4212-8212-121212121212' },
    commercialSettingsDecision: { decisionRef: 'settings:order-unit', decisionRevision: '1' },
    contextRef: 'purchase-context:order-unit',
    contextRevision: '1',
    currencyResolution: { currencyCode: 'CZK', resolutionRef: 'currency:order-unit', resolutionRevision: '1' },
    subject: { authorizationSubject: { kind: 'RETAIL' }, kind: 'PROFILE', profileRef: subjectRef },
  },
  tenantId,
};

const ownerScope2 = {
  ownerModuleId: 'commerce.market-catalog',
  ownerRootRef: 'pricing:commercial-context:quotation-fixture-root',
  predicateRef,
  tenantId,
};

const market = {
  _tag: verifiedPresent,
  completeness: {
    completenessEvidence,
    currencyCode: 'CZK',
    family: commercialContext,
    ownerScope: ownerScope2,
    ownerSetRevisionRef: ownerRevision,
    temporal,
    verification: { kind: ownerVerifiableOpaqueReference, verificationRef },
  },
  currentFacts: [
    {
      currencyCode: 'CZK',
      effectivePeriod: { effectiveFrom, effectiveTo: null },
      factRef: 'pricing:commercial-context:quotation-fixture-fact',
      factRevisionRef: 'pricing:commercial-context:quotation-fixture-revision',
      family: commercialContext,
      ownerScope: ownerScope2,
      temporal,
      verification: { kind: ownerVerifiableOpaqueReference, verificationRef },
    },
  ],
  request: {
    currencyCode: 'CZK',
    effectiveAt: observedAt,
    family: commercialContext,
    ownerScope: ownerScope2,
    requestedAt: observedAt,
  },
};

const ownerScope3 = {
  ownerModuleId: 'commerce.promotion',
  ownerRootRef: 'pricing:promotion:quotation-fixture-root',
  predicateRef: 'pricing:promotion:quotation-fixture-predicate',
  tenantId,
};

const promotion = {
  kind: promotionSelected,
  sourceEvidence: {
    _tag: verifiedPresent,
    completeness: {
      completenessEvidence: {
        observedAt,
        ownerRevision: 'pricing:promotion:quotation-fixture-set-revision',
        scope: { kind: exactPredicate, predicateRef: 'pricing:promotion:quotation-fixture-predicate' },
      },
      currencyCode: 'CZK',
      family: 'PROMOTION',
      ownerScope: ownerScope3,
      ownerSetRevisionRef: 'pricing:promotion:quotation-fixture-set-revision',
      temporal,
      verification: {
        kind: ownerVerifiableOpaqueReference,
        verificationRef: 'pricing:promotion:quotation-fixture-proof',
      },
    },
    currentFacts: [
      {
        currencyCode: 'CZK',
        effectivePeriod: { effectiveFrom, effectiveTo: null },
        factRef: 'pricing:promotion:quotation-fixture-fact',
        factRevisionRef: 'pricing:promotion:quotation-fixture-revision',
        family: 'PROMOTION',
        ownerScope: ownerScope3,
        temporal,
        verification: {
          kind: ownerVerifiableOpaqueReference,
          verificationRef: 'pricing:promotion:quotation-fixture-proof',
        },
      },
    ],
    request: {
      currencyCode: 'CZK',
      effectiveAt: observedAt,
      family: 'PROMOTION',
      ownerScope: ownerScope3,
      requestedAt: observedAt,
    },
  },
};

const externalOwnerEvidence = {
  candidateRef,
  catalogSelections,
  decision,
  market,
  promotion,
  requestedAt: observedAt,
  subject: {
    guestEvidenceRef: 'guest-evidence:quotation-fixture',
    guestSessionRef: 'guest-session:quotation-fixture',
    kind: 'GUEST',
  },
  validatedAt: observedAt,
};

const breakdown = {
  baseLineTotal: { amount: '100', currencyCode: 'CZK' },
  commercialFeeTotal: { amount: '0', currencyCode: 'CZK' },
  pricingLineRoundingAdjustmentTotal: { amount: '0', currencyCode: 'CZK' },
  pricingOwnedDiscountTotal: { amount: '-30', currencyCode: 'CZK' },
  promotionAllocationTotal: { amount: '0', currencyCode: 'CZK' },
  zeroFloorAdjustmentTotal: { amount: '0', currencyCode: 'CZK' },
};

const publishedLines = [
  {
    occurrenceId: 'line-779',
    publicationProfile: {
      currencyCode: 'CZK',
      profileKind: 'PUBLICATION',
      profileVersion: 'pricing-czk-publication-v1',
      publishedScale: 2,
      quantum: '0.01',
      roundingMode: 'HALF_UP',
    },
    publishedLineValue: { amount: '70', currencyCode: 'CZK' },
    roundingAdjustment: { amount: '0', currencyCode: 'CZK' },
  },
];

const supportRevisionRef = {
  moduleId: commercePricing,
  resourceId: candidateRef,
  resourceType: 'commerce.pricing.currency-support-revision',
  supportRootId,
  tenantId,
};

const supportRootRef = {
  moduleId: commercePricing,
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support',
  tenantId,
};

const currencySupport = {
  completenessEvidence: {
    nextApplicabilityBoundary: validUntil,
    observedAt: observedAt2,
    ownerRevision: candidateRef,
    scope: {
      kind: exactPredicate,
      predicateRef: 'commerce.pricing.current-supported-currencies:11111111-1111-4111-8111-111111111111',
    },
  },
  currentnessEvidence: {
    evaluatedAt: observedAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt: observedAt2,
    revalidatedAt,
    scheduleRevision: 1,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt: observedAt,
  effectivePeriod: { effectiveFrom, effectiveTo: null },
  factProofs: [
    {
      factRef: supportRootId,
      factRevisionRef: candidateRef,
      verificationRef:
        'commerce.pricing.currency-support-proof:11111111-1111-4111-8111-111111111111:88888888-8888-4888-8888-888888888888:99999999-9999-4999-8999-999999999999:CZK:2026-09-28T12:00:00.000Z:2026-09-28T12:00:00.050Z',
    },
  ],
  generation: 1,
  nextApplicabilityBoundary: validUntil,
  observedAt: observedAt2,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: 'pricing-currency-support:778',
  scheduleRevision: 1,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef:
    'commerce.pricing.currency-support-proof:11111111-1111-4111-8111-111111111111:88888888-8888-4888-8888-888888888888:99999999-9999-4999-8999-999999999999:CZK:2026-09-28T12:00:00.000Z:2026-09-28T12:00:00.050Z',
};

const priceRef = {
  moduleId: commercePricing,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.pricing.price',
  tenantId,
};

const basis = {
  amount: { amount: '100', currencyCode: 'CZK' },
  applicablePricingFeeTotal: { amount: '0', currencyCode: 'CZK' },
  baseLineValue: { amount: '100', currencyCode: 'CZK' },
  occurrenceId: 'line-779',
};

const basis2 = { catalogSelection: selection, kind: variantLine, unitBasis: pricingBasis };

const applicabilityBasis = {
  basis: basis2,
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
  currencyCode: 'CZK',
  observedAt,
};

const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
};

const basePricePath = { kind: 'PRICE_GROUP_PRICE', priceGroupRef, priceRef, priceRevisionId };

const audience = { kind: 'CATALOG_PATH', selection };

const identityKey = {
  audience,
  basis: basis2,
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
  currencyCode: 'CZK',
  effectKind: fixedMonetaryAmount,
  family: 'CATALOG_DISCOUNT',
  monetaryBoundary: 'PRE_TAX',
  scope: variantLine,
};

const audience2 = { kind: 'PRICE_GROUP', priceGroupRef };

const compatibility = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom, effectiveTo: null },
  definitionRevisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  definitionRevisionNumber: 1,
  meaningFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: observedAt,
  verifiedAt: observedAt,
};

const interpretation = {
  _tag: 'ASSIGNED',
  assignmentResolution: {
    _tag: 'ASSIGNED',
    assignmentRef: {
      moduleId: commerceCustomerContext,
      resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      resourceType: 'commerce.customer-context.customer-price-group-assignment',
      tenantId,
    },
    assignmentRevision: 1,
    compatibility,
    effectiveFrom,
    effectiveTo: null,
    priceGroupRef,
  },
  basis: {
    catalogSelection: selection,
    commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
    currencyCode: 'CZK',
    unitBasis: pricingBasis,
  },
  compatibilityEvidence: compatibility,
  discountAudience: audience2,
  priceGroupRef,
  priceSelector: audience2,
};

const identityKey2 = {
  audience: audience2,
  basis: basis2,
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
  currencyCode: 'CZK',
  effectKind: fixedMonetaryAmount,
  family: 'CONTRACTUAL_DISCOUNT',
  monetaryBoundary: 'PRE_TAX',
  scope: variantLine,
};

const audience3 = {
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '10101010-1010-4101-8101-101010101010',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  kind: 'COUNTERPARTY',
};

const identityKey3 = {
  audience: audience3,
  basis: basis2,
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
  currencyCode: 'CZK',
  effectKind: fixedMonetaryAmount,
  family: 'CONTRACTUAL_DISCOUNT',
  monetaryBoundary: 'PRE_TAX',
  scope: variantLine,
};

const priceRevision = {
  effectiveFrom,
  monetaryAmount: { amount: '100', currencyCode: 'CZK' },
  monetaryBoundary: 'PRE_TAX',
  revision: 1,
  revisionId: priceRevisionId,
};

const exactKey = {
  catalogSelection: selection,
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: audience2,
  unitBasis: pricingBasis,
};

const lineQuantity = {
  quantity: '1',
  quantityBasis: { catalogQuantityBasis: quantityBasis, priceUnitBasis: pricingBasis },
};

const price = { identityKey: exactKey, priceRef, revision: priceRevision };

const price2 = { quantity: '1', quantityBasis };

const composition = {
  feeCalculation: {
    contributions: [],
    contributionTotal: { amount: '0', currencyCode: 'CZK' },
    discountableLineBasis: { amount: '100', currencyCode: 'CZK' },
    input: {
      baseLineValue: { amount: '100', currencyCode: 'CZK' },
      currencySupport,
      decision,
      feeSet: {
        commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
        completenessEvidence: {
          observedAt,
          ownerRevision: 'pricing-commercial-fees:779',
          scope: {
            kind: exactPredicate,
            predicateRef:
              'pricing-commercial-fee-current-set:v1:11111111-1111-4111-8111-111111111111:commerce.catalog:commerce.catalog.variant:33333333-3333-4333-8333-333333333333:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:B2C:cz-launch:CZK',
          },
        },
        currencyCode: 'CZK',
        currentnessEvidence: {
          observedAt,
          ownerRevision: 'pricing-commercial-fees:779',
          predicateRef:
            'pricing-commercial-fee-current-set:v1:11111111-1111-4111-8111-111111111111:commerce.catalog:commerce.catalog.variant:33333333-3333-4333-8333-333333333333:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:B2C:cz-launch:CZK',
          revalidatedAt: observedAt,
          verificationMode: 'OWNER_CURRENT_SET_REVALIDATED',
        },
        fees: [],
        observedAt,
        target: { variantRef },
      },
      occurrenceId: 'line-779',
      pricePath: { priceRef, priceRevisionId, source: 'PRICE_GROUP_PRICE' },
    },
    outcome: 'COMMERCIAL_FEES_APPLIED',
  },
  line: linesItem0,
  lineDiscountContributions: [
    {
      amount: { amount: '-10', currencyCode: 'CZK' },
      applicationCount: oncePerStableLine,
      basis,
      candidate: {
        applicationCount: oncePerStableLine,
        audienceBinding: {
          applicabilityBasis,
          basePricePath,
          evidence: { audience, catalogEvidence: evidence, kind: 'CATALOG_OWNER_EVIDENCE' },
          identityKey,
        },
        definition: {
          discountId: '31313131-3131-4313-8313-313131313131',
          identityKey,
          revision: {
            configuredEffect: { kind: fixedMonetaryAmount, level: { amount: '10', currencyCode: 'CZK' } },
            effectiveFrom,
            revision: 1,
            revisionId: '41414141-4141-4414-8414-414141414141',
          },
        },
        kind: variantLine,
        layer: 'CATALOG',
        occurrenceId: 'line-779',
        outcome: discountApplicable,
      },
      contributionDirection: nonPositiveReduction,
    },
    {
      amount: { amount: '-10', currencyCode: 'CZK' },
      applicationCount: oncePerStableLine,
      basis,
      candidate: {
        applicationCount: oncePerStableLine,
        audienceBinding: {
          applicabilityBasis,
          basePricePath,
          evidence: { audience: audience2, interpretation, kind: 'PRICE_GROUP_OWNER_EVIDENCE' },
          identityKey: identityKey2,
        },
        definition: {
          discountId: '32313131-3131-4313-8313-313131313132',
          identityKey: identityKey2,
          revision: {
            configuredEffect: { kind: fixedMonetaryAmount, level: { amount: '10', currencyCode: 'CZK' } },
            effectiveFrom,
            revision: 1,
            revisionId: '42414141-4141-4414-8414-414141414142',
          },
        },
        kind: variantLine,
        layer: 'PRICE_GROUP_CONTRACTUAL',
        occurrenceId: 'line-779',
        outcome: discountApplicable,
      },
      contributionDirection: nonPositiveReduction,
    },
    {
      amount: { amount: '-10', currencyCode: 'CZK' },
      applicationCount: oncePerStableLine,
      basis,
      candidate: {
        applicationCount: oncePerStableLine,
        audienceBinding: {
          applicabilityBasis,
          basePricePath,
          evidence: {
            audience: audience3,
            kind: 'COUNTERPARTY_OWNER_EVIDENCE',
            observedAt,
            ownerRevision: 'party-registry:779',
            source: 'PARTY_REGISTRY',
          },
          identityKey: identityKey3,
        },
        definition: {
          discountId: '33313131-3131-4313-8313-313131313133',
          identityKey: identityKey3,
          revision: {
            configuredEffect: { kind: fixedMonetaryAmount, level: { amount: '10', currencyCode: 'CZK' } },
            effectiveFrom,
            revision: 1,
            revisionId: '43414141-4141-4414-8414-414141414143',
          },
        },
        kind: variantLine,
        layer: 'COUNTERPARTY_CONTRACTUAL',
        occurrenceId: 'line-779',
        outcome: discountApplicable,
      },
      contributionDirection: nonPositiveReduction,
    },
  ],
  negativeOrigin: 'NONE',
  occurrenceId: 'line-779',
  prePromotionValue: { amount: '70', currencyCode: 'CZK' },
  rawPostCompositionValue: { amount: '70', currencyCode: 'CZK' },
  unitPriceCalculation: {
    _tag: 'UNIT_PRICE_CALCULATED',
    arithmeticProfileVersion: 'pricing-arithmetic-v1',
    baseLineValue: { amount: '100', currencyCode: 'CZK' },
    input: {
      exactPrice: {
        _tag: 'PRICE_FOUND',
        currencySupport,
        path: {
          _tag: 'GROUP_PRICE',
          discountAudience: audience2,
          resolutionInput: { _tag: 'ASSIGNED', effectiveAt: observedAt, interpretation },
          usedPrice: {
            _tag: 'FOUND',
            evidence: {
              effectiveAt: observedAt,
              nextApplicabilityBoundary: validUntil,
              observedAt: observedAt2,
              ownerRevision: 'pricing-price-set:778',
            },
            priceRef,
            priceRevision,
            request: { effectiveAt: observedAt, exactKey },
          },
        },
      },
      line: linesItem0,
      lineQuantity,
      quantityBasis: {
        attempt: { catalog, effectiveAt: observedAt, occurrenceId: 'line-779', price },
        evidence: {
          completeness,
          currentness: { observedAt, ownerRevision: catalogQuantity778, status: 'CURRENT', validUntil },
          currentnessEvidence: {
            effectiveAt: observedAt,
            generation: catalogQuantity778,
            observedAt,
            predicateRef: predicateRef2,
            revalidatedAt: observedAt,
            validUntil,
            verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
          },
          effectiveAt: observedAt,
          endpoints: { price: price2, purchase: price2, requested: price2 },
          equivalentSelectionKey: 'pricing-purpose:33333333-3333-4333-8333-333333333333',
          generation: catalogQuantity778,
          hierarchyRevision: 'catalog-hierarchy:778',
          observedAt,
          outcome: 'NO_CONVERSION_REQUIRED',
          ownerModuleId: commerceCatalog,
          ownerRevision: catalogQuantity778,
          requestedOwnerRevision: catalogQuantity778,
          requestedQuantity: '1',
          requestedQuantityBasis: quantityBasis,
          requestedUnitRef: unitRef,
          selection,
          source: 'CATALOG_OWNER_CURRENT_READ',
          verificationReceipt: {
            generation: catalogQuantity778,
            issuedAt: observedAt,
            ownerModuleId: commerceCatalog,
            ownerRevision: catalogQuantity778,
            predicate: {
              effectiveAt: observedAt,
              price: price2,
              requestedQuantity: '1',
              requestedQuantityBasis: quantityBasis,
              requestedUnitRef: unitRef,
              selection,
            },
            predicateRef: predicateRef2,
            verificationRef:
              'commerce.catalog.quantity-basis-predicate:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:1:3:33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444:7:2026-09-28T12:00:00.000Z:55555555-5555-4555-8555-555555555555:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:1:NO_TIER:NO_TIER_ENDPOINT:verification:catalog-quantity:778:2026-09-28T12:00:00.000Z',
          },
        },
        occurrenceId: 'line-779',
        outcome: 'NO_CONVERSION_REQUIRED',
        priceQuantity: quantity,
        requestedQuantity: quantity,
        resultingPurchaseQuantity: quantity,
        selection,
      },
      tierSelection: {
        appliesToQuantity: lineQuantity,
        evidence: {
          decision: { kind: 'NO_THRESHOLD_REACHED' },
          input: {
            attempt: {
              evaluatedAt: observedAt,
              exactPrice: {
                path: { priceGroupSelector: audience2, requiredAbsenceEvidence: [] },
                price: {
                  definition: price,
                  effectivePeriod: { effectiveFrom, effectiveTo: null },
                  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
                },
                scheduleRevision: 1,
              },
              normalizedQuantity: lineQuantity,
              tierSetPriceRef: priceRef,
            },
            tierSet: {
              authority: {
                generation: 778,
                observedAt: revalidatedAt,
                ownerRevision: 'pricing-quantity-tier-set:778',
                ownerRootRef: 'commerce.pricing.quantity-tier-set:55555555-5555-4555-8555-555555555555',
                predicateRef: 'commerce.pricing.current-quantity-tiers:55555555-5555-4555-8555-555555555555',
                verificationRef: 'commerce.pricing.quantity-tier-set-proof:778',
              },
              completenessEvidence: {
                nextApplicabilityBoundary: validUntil,
                observedAt: revalidatedAt,
                ownerRevision: 'pricing-quantity-tier-set:778',
                scope: {
                  kind: exactPredicate,
                  predicateRef: 'commerce.pricing.current-quantity-tiers:55555555-5555-4555-8555-555555555555',
                },
              },
              currentTiers: [],
              factProofs: [],
              priceRef,
            },
          },
        },
        monetaryBoundary: 'PRE_TAX',
        outcome: 'BASE_PRICE_RETAINED',
        resultingUnitPrice: { amount: '100', currencyCode: 'CZK' },
      },
    },
    monetaryBoundary: 'PRE_TAX',
    resultingQuantity: quantity,
    unitPrice: { amount: '100', currencyCode: 'CZK' },
  },
};

const lines2 = [
  {
    composition,
    floorEvaluation: {
      floorAdjustment: { amount: '0', currencyCode: 'CZK' },
      kind: 'NOT_REQUIRED',
      nonNegativePreRoundValue: { amount: '70', currencyCode: 'CZK' },
      rawPostCompositionValue: { amount: '70', currencyCode: 'CZK' },
    },
    nonNegativePreRoundValue: { amount: '70', currencyCode: 'CZK' },
    occurrenceId: 'line-779',
  },
];

const lines3 = [composition];

const currencySupport2 = {
  currencyCode: 'CZK',
  evidenceRef: 'currency-support:779',
  observedAt,
  ownerRevision: 'currency-support-r779',
  status: 'SUPPORTED_CURRENT',
  tenantId,
};

const ownerEvidence = {
  completenessEvidence: {
    nextApplicabilityBoundary: '2026-09-28T13:00:00.000Z',
    observedAt,
    ownerRevision: promotionR779,
    scope: { kind: exactPredicate, predicateRef: promotionCandidate779 },
  },
  currentness: { evaluatedAt: observedAt, observedAt, revalidatedAt: observedAt, status: 'CURRENT' },
  exactPredicateRef: promotionCandidate779,
  ownerModuleId: 'commerce.promotion',
  ownerRevision: promotionR779,
  provenanceRef: 'promotion-proof:779',
};

const subjectEvidence = {
  evidenceRef: 'subject-evidence:779',
  observedAt,
  ownerModuleId: commerceCustomerContext,
  ownerRevision: 'subject-r779',
  provenanceRef: 'subject-proof:779',
  revalidatedAt: observedAt,
  subject: { guestEvidenceRef: 'guest-session:779', kind: 'GUEST', tenantId },
};

const lines4 = [
  {
    catalogSelection: selection,
    occurrenceId: 'line-779',
    prePromotionValue: { amount: '70', currencyCode: 'CZK' },
    rawPreTaxValue: { amount: '70', currencyCode: 'CZK' },
    recipientKind: 'MERCHANDISE',
  },
];

const commercialTotal = {
  breakdown,
  calculationVersions,
  candidateRef,
  decision,
  outcome: 'COMMERCIAL_TOTAL_READY',
  pricingNetCommercialTotal: { amount: '70', currencyCode: 'CZK' },
  publishedLines,
  sourceEvidence: {
    preRound: {
      decision,
      lines: lines2,
      outcome: 'PRE_ROUND_LINE_VALUES_READY',
      rawComposition: {
        candidateRef,
        decision,
        lines: lines3,
        outcome: 'RAW_COMPOSITION_READY',
        promotionComposition: {
          composition: {
            candidateRef,
            completedPricingAllocationRefs: [pricingComposition779],
            currentnessEvidence: {
              applicationRequestRef: promotionRequest779,
              candidateRef,
              currencySupport: currencySupport2,
              exactPredicateRef: promotionCandidate779,
              ownerEvidence,
              pricingCompositionRef: pricingComposition779,
              pricingCompositionRevision: 'pricing-composition-r779',
              subjectEvidence,
            },
            decision,
            lines: lines4,
            outcome: 'PROMOTION_COMPOSITION_READY',
            promotion: {
              acceptedRequest: {
                applicationRequestRef: promotionRequest779,
                candidateRef,
                exactPredicateRef: promotionCandidate779,
                subjectEvidence,
              },
              outcome: 'PROMOTION_NOT_APPLICABLE',
              ownerDecisionRevision: promotionR779,
              ownerEvidence,
              reason: 'NO_APPLICABLE_APPLICATION',
            },
            stage: 'AFTER_PRICE_TIER_FEES_ALL_PRICING_DISCOUNTS_AND_PROMOTION',
          },
          kind: promotionSelected,
        },
      },
    },
  },
};

const ownerScope4 = {
  ownerModuleId: commercePricing,
  ownerRootRef: 'pricing:currency-support:quotation-fixture-root',
  predicateRef: 'pricing:currency-support:quotation-fixture-predicate',
  tenantId,
};

const currencySupport3 = {
  _tag: verifiedPresent,
  completeness: {
    completenessEvidence: {
      observedAt,
      ownerRevision: 'pricing:currency-support:quotation-fixture-set-revision',
      scope: { kind: exactPredicate, predicateRef: 'pricing:currency-support:quotation-fixture-predicate' },
    },
    currencyCode: 'CZK',
    family: currencySupport4,
    ownerScope: ownerScope4,
    ownerSetRevisionRef: 'pricing:currency-support:quotation-fixture-set-revision',
    temporal,
    verification: {
      kind: ownerVerifiableOpaqueReference,
      verificationRef: 'pricing:currency-support:quotation-fixture-proof',
    },
  },
  currentFacts: [
    {
      currencyCode: 'CZK',
      effectivePeriod: { effectiveFrom, effectiveTo: null },
      factRef: 'pricing:currency-support:quotation-fixture-fact',
      factRevisionRef: 'pricing:currency-support:quotation-fixture-revision',
      family: currencySupport4,
      ownerScope: ownerScope4,
      temporal,
      verification: {
        kind: ownerVerifiableOpaqueReference,
        verificationRef: 'pricing:currency-support:quotation-fixture-proof',
      },
    },
  ],
  request: {
    currencyCode: 'CZK',
    effectiveAt: observedAt,
    family: currencySupport4,
    ownerScope: ownerScope4,
    requestedAt: observedAt,
  },
};

const ownerScope5 = {
  ownerModuleId: commercePricing,
  ownerRootRef: 'pricing:commercial-fee:quotation-fixture-root',
  predicateRef: 'pricing:commercial-fee:quotation-fixture-predicate',
  tenantId,
};

const ownerScope6 = {
  ownerModuleId: commercePricing,
  ownerRootRef: 'pricing:discount:quotation-fixture-root',
  predicateRef: 'pricing:discount:quotation-fixture-predicate',
  tenantId,
};

const lineDiscounts = {
  kind: 'DISCOUNT_SELECTED',
  sourceEvidence: {
    _tag: verifiedPresent,
    completeness: {
      completenessEvidence: {
        observedAt,
        ownerRevision: 'pricing:discount:quotation-fixture-set-revision',
        scope: { kind: exactPredicate, predicateRef: 'pricing:discount:quotation-fixture-predicate' },
      },
      currencyCode: 'CZK',
      family: 'DISCOUNT',
      ownerScope: ownerScope6,
      ownerSetRevisionRef: 'pricing:discount:quotation-fixture-set-revision',
      temporal,
      verification: {
        kind: ownerVerifiableOpaqueReference,
        verificationRef: 'pricing:discount:quotation-fixture-proof',
      },
    },
    currentFacts: [
      {
        currencyCode: 'CZK',
        effectivePeriod: { effectiveFrom, effectiveTo: null },
        factRef: 'pricing:discount:quotation-fixture-fact',
        factRevisionRef: 'pricing:discount:quotation-fixture-revision',
        family: 'DISCOUNT',
        ownerScope: ownerScope6,
        temporal,
        verification: {
          kind: ownerVerifiableOpaqueReference,
          verificationRef: 'pricing:discount:quotation-fixture-proof',
        },
      },
    ],
    request: {
      currencyCode: 'CZK',
      effectiveAt: observedAt,
      family: 'DISCOUNT',
      ownerScope: ownerScope6,
      requestedAt: observedAt,
    },
  },
};

const ownerScope7 = {
  ownerModuleId: commercePricing,
  ownerRootRef: 'pricing:price:quotation-fixture-root',
  predicateRef: 'pricing:price:quotation-fixture-predicate',
  tenantId,
};

const ownerScope8 = {
  ownerModuleId: commercePricing,
  ownerRootRef: 'pricing:quantity-tier:quotation-fixture-root',
  predicateRef: 'pricing:quantity-tier:quotation-fixture-predicate',
  tenantId,
};

const lines5 = [
  {
    commercialFees: {
      _tag: verifiedPresent,
      completeness: {
        completenessEvidence: {
          observedAt,
          ownerRevision: 'pricing:commercial-fee:quotation-fixture-set-revision',
          scope: { kind: exactPredicate, predicateRef: 'pricing:commercial-fee:quotation-fixture-predicate' },
        },
        currencyCode: 'CZK',
        family: commercialFee,
        ownerScope: ownerScope5,
        ownerSetRevisionRef: 'pricing:commercial-fee:quotation-fixture-set-revision',
        temporal,
        verification: {
          kind: ownerVerifiableOpaqueReference,
          verificationRef: 'pricing:commercial-fee:quotation-fixture-proof',
        },
      },
      currentFacts: [
        {
          currencyCode: 'CZK',
          effectivePeriod: { effectiveFrom, effectiveTo: null },
          factRef: 'pricing:commercial-fee:quotation-fixture-fact',
          factRevisionRef: 'pricing:commercial-fee:quotation-fixture-revision',
          family: commercialFee,
          ownerScope: ownerScope5,
          temporal,
          verification: {
            kind: ownerVerifiableOpaqueReference,
            verificationRef: 'pricing:commercial-fee:quotation-fixture-proof',
          },
        },
      ],
      request: {
        currencyCode: 'CZK',
        effectiveAt: observedAt,
        family: commercialFee,
        ownerScope: ownerScope5,
        requestedAt: observedAt,
      },
    },
    lineDiscounts,
    occurrenceId: 'line-779',
    pricePath: {
      usedPrice: {
        _tag: verifiedPresent,
        completeness: {
          completenessEvidence: {
            observedAt,
            ownerRevision: 'pricing:price:quotation-fixture-set-revision',
            scope: { kind: exactPredicate, predicateRef: 'pricing:price:quotation-fixture-predicate' },
          },
          currencyCode: 'CZK',
          family: 'PRICE',
          ownerScope: ownerScope7,
          ownerSetRevisionRef: 'pricing:price:quotation-fixture-set-revision',
          temporal,
          verification: {
            kind: ownerVerifiableOpaqueReference,
            verificationRef: 'pricing:price:quotation-fixture-proof',
          },
        },
        currentFacts: [
          {
            currencyCode: 'CZK',
            effectivePeriod: { effectiveFrom, effectiveTo: null },
            factRef: 'pricing:price:quotation-fixture-fact',
            factRevisionRef: 'pricing:price:quotation-fixture-revision',
            family: 'PRICE',
            ownerScope: ownerScope7,
            temporal,
            verification: {
              kind: ownerVerifiableOpaqueReference,
              verificationRef: 'pricing:price:quotation-fixture-proof',
            },
          },
        ],
        request: {
          currencyCode: 'CZK',
          effectiveAt: observedAt,
          family: 'PRICE',
          ownerScope: ownerScope7,
          requestedAt: observedAt,
        },
      },
    },
    quantityTiers: {
      _tag: verifiedPresent,
      completeness: {
        completenessEvidence: {
          observedAt,
          ownerRevision: 'pricing:quantity-tier:quotation-fixture-set-revision',
          scope: { kind: exactPredicate, predicateRef: 'pricing:quantity-tier:quotation-fixture-predicate' },
        },
        currencyCode: 'CZK',
        family: quantityTier,
        ownerScope: ownerScope8,
        ownerSetRevisionRef: 'pricing:quantity-tier:quotation-fixture-set-revision',
        temporal,
        verification: {
          kind: ownerVerifiableOpaqueReference,
          verificationRef: 'pricing:quantity-tier:quotation-fixture-proof',
        },
      },
      currentFacts: [
        {
          currencyCode: 'CZK',
          effectivePeriod: { effectiveFrom, effectiveTo: null },
          factRef: 'pricing:quantity-tier:quotation-fixture-fact',
          factRevisionRef: 'pricing:quantity-tier:quotation-fixture-revision',
          family: quantityTier,
          ownerScope: ownerScope8,
          temporal,
          verification: {
            kind: ownerVerifiableOpaqueReference,
            verificationRef: 'pricing:quantity-tier:quotation-fixture-proof',
          },
        },
      ],
      request: {
        currencyCode: 'CZK',
        effectiveAt: observedAt,
        family: quantityTier,
        ownerScope: ownerScope8,
        requestedAt: observedAt,
      },
    },
  },
];

const wholePurchase = { contractualDiscounts: lineDiscounts };

const validity = {
  policyEvidence: { maximumValidityDurationMilliseconds: 3_600_000, policyRef: 'policy', policyVersion: '1' },
  validFrom: observedAt,
  validUntil: '2026-09-28T13:00:00.000Z',
};

const externalOwnerEvidence2 = {
  candidateRef: candidateRef2,
  catalogSelections,
  decision,
  market,
  promotion,
  requestedAt: observedAt,
  subject: {
    guestEvidenceRef: 'guest-evidence:quotation-fixture',
    guestSessionRef: 'guest-session:quotation-fixture',
    kind: 'GUEST',
  },
  validatedAt: observedAt,
};

const commercialTotal2 = {
  breakdown,
  calculationVersions,
  candidateRef: candidateRef2,
  decision,
  outcome: 'COMMERCIAL_TOTAL_READY',
  pricingNetCommercialTotal: { amount: '70', currencyCode: 'CZK' },
  publishedLines,
  sourceEvidence: {
    preRound: {
      decision,
      lines: lines2,
      outcome: 'PRE_ROUND_LINE_VALUES_READY',
      rawComposition: {
        candidateRef: candidateRef2,
        decision,
        lines: lines3,
        outcome: 'RAW_COMPOSITION_READY',
        promotionComposition: {
          composition: {
            candidateRef: candidateRef2,
            completedPricingAllocationRefs: [pricingComposition779],
            currentnessEvidence: {
              applicationRequestRef: promotionRequest779,
              candidateRef: candidateRef2,
              currencySupport: currencySupport2,
              exactPredicateRef: promotionCandidate779,
              ownerEvidence,
              pricingCompositionRef: pricingComposition779,
              pricingCompositionRevision: 'pricing-composition-r779',
              subjectEvidence,
            },
            decision,
            lines: lines4,
            outcome: 'PROMOTION_COMPOSITION_READY',
            promotion: {
              acceptedRequest: {
                applicationRequestRef: promotionRequest779,
                candidateRef: candidateRef2,
                exactPredicateRef: promotionCandidate779,
                subjectEvidence,
              },
              outcome: 'PROMOTION_NOT_APPLICABLE',
              ownerDecisionRevision: promotionR779,
              ownerEvidence,
              reason: 'NO_APPLICABLE_APPLICATION',
            },
            stage: 'AFTER_PRICE_TIER_FEES_ALL_PRICING_DISCOUNTS_AND_PROMOTION',
          },
          kind: promotionSelected,
        },
      },
    },
  },
};

export const orderCandidateQuotation = {
  binding: {
    candidateRef,
    commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
    currencyCode: 'CZK',
    lines,
    monetaryBoundary: 'PRE_TAX',
    subject,
    tenantId,
  },
  issuedAt: observedAt,
  kind: 'PRICING_QUOTATION',
  materialEvidence: {
    calculationVersions,
    candidateRef,
    externalOwnerEvidence,
    outcome: 'PRICING_MATERIAL_EVIDENCE_READY',
    sourceEvidence: {
      commercialTotal,
      currencySupport: currencySupport3,
      externalOwnerEvidence,
      lines: lines5,
      requestedAt: observedAt,
      revalidatedAt: observedAt,
      wholePurchase,
    },
    validatedAt: observedAt,
  },
  quotationRef: 'quotation:order-finalization',
  quotedResult: commercialTotal,
  validity,
};

export const otherCandidateQuotation = {
  binding: {
    candidateRef: candidateRef2,
    commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId },
    currencyCode: 'CZK',
    lines,
    monetaryBoundary: 'PRE_TAX',
    subject,
    tenantId,
  },
  issuedAt: observedAt,
  kind: 'PRICING_QUOTATION',
  materialEvidence: {
    calculationVersions,
    candidateRef: candidateRef2,
    externalOwnerEvidence: externalOwnerEvidence2,
    outcome: 'PRICING_MATERIAL_EVIDENCE_READY',
    sourceEvidence: {
      commercialTotal: commercialTotal2,
      currencySupport: currencySupport3,
      externalOwnerEvidence: externalOwnerEvidence2,
      lines: lines5,
      requestedAt: observedAt,
      revalidatedAt: observedAt,
      wholePurchase,
    },
    validatedAt: observedAt,
  },
  quotationRef: 'quotation:order-finalization',
  quotedResult: commercialTotal2,
  validity,
};
