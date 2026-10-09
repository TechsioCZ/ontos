import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDecisionOutcomeKindSchema,
  PricingDecisionOutcomeSchema,
  PricingDecisionSchema,
  PricingLineInputAssessmentSchema,
} from '../../src/domain/pricing-decision.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const productUnitId = '55555555-5555-4555-8555-555555555555';
const packageId = '66666666-6666-4666-8666-666666666666';
const configurationDefinitionId = '77777777-7777-4777-8777-777777777777';
const setCompositionId = '88888888-8888-4888-8888-888888888888';

const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef(productId, 'commerce.catalog.product');
const variantRef = catalogRef(variantId, 'commerce.catalog.variant');
const productUnitRef = catalogRef(productUnitId, 'commerce.catalog.product-unit');
const packageRef = catalogRef(packageId, 'commerce.catalog.package-definition');
const exactSelection = { productRef, variantRef };
const richSelection = {
  configuration: {
    choices: [{ choiceKey: 'finish', value: 'blue' }],
    definition: {
      resourceRef: catalogRef(configurationDefinitionId, 'commerce.catalog.configuration-definition'),
      revision: 4,
    },
    productRef,
    variantRef,
  },
  packageOption: {
    contentRevision: { resourceRef: packageRef, revision: 5 },
    optionRef: packageRef,
  },
  productRef,
  setComposition: {
    resourceRef: catalogRef(setCompositionId, 'commerce.catalog.set-composition'),
    revision: 6,
  },
  variantRef,
};

const catalogEvidenceFor = (selection: typeof exactSelection | typeof richSelection) => {
  const variantRevision = { resourceRef: selection.variantRef, revision: 2 };
  return {
    assessedAt: '2026-09-22T09:59:59.000Z',
    basis: [
      { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 1 } },
      { role: 'VARIANT', source: variantRevision },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: selection.productRef, revision: 1 },
      },
      ...('packageOption' in selection
        ? [{ role: 'PACKAGE_CONTENT', source: selection.packageOption.contentRevision }]
        : []),
      ...('configuration' in selection
        ? [{ role: 'CONFIGURATION_DEFINITION', source: selection.configuration.definition }]
        : []),
      ...('setComposition' in selection ? [{ role: 'SET_COMPOSITION', source: selection.setComposition }] : []),
    ],
    membership: {
      attestationId: '99999999-9999-4999-8999-999999999999',
      observedAt: '2026-09-22T09:59:59.000Z',
      productRef: selection.productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: variantRevision,
    },
    purpose: 'PRICING',
    selection,
    status: 'VALID',
  } as const;
};

const catalogHandoffFor = (
  selection: typeof exactSelection | typeof richSelection = exactSelection,
  targetRef = variantRef,
) => ({
  completeness: {
    observedAt: '2026-09-22T09:59:59.000Z',
    ownerRevision: 'catalog-quantity:17',
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: 'catalog-quantity:exact-selection',
    },
  },
  divisible: false,
  equivalentSelectionKey: 'catalog-selection:exact',
  evidence: catalogEvidenceFor(selection),
  hierarchyRevision: 'catalog-hierarchy:9',
  ownerRevision: 'catalog-quantity:17',
  quantity: {
    changed: false,
    notice: null,
    requested: '2',
    resulting: '2',
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
    step: '1',
    targetId: targetRef.resourceId,
    tenantId,
    unitId: productUnitId,
    unitRuleRevision: 7,
  },
  quantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef,
    unitRef: productUnitRef,
    unitRuleRevision: 7,
  },
  selection,
  status: 'READY' as const,
  unitRef: productUnitRef,
});

const line = (
  occurrenceId: string,
  selection: typeof exactSelection | typeof richSelection = exactSelection,
  targetRef = variantRef,
) => ({
  catalog: catalogHandoffFor(selection, targetRef),
  occurrenceId,
  pricingBasis: {
    quantity: '1',
    unitRef: productUnitRef,
  },
});

const decision = {
  commercialScope: {
    channelId: 'B2C',
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  lines: [line('demand-occurrence-1')],
  monetaryBoundary: 'PRE_TAX',
  operationTime: '2026-09-22T10:00:00.000Z',
  purchasingContext: {
    accessDecision: {
      decisionRef: 'commerce-access-decision:41',
      decisionRevision: 'commerce-access-decision-r41',
    },
    actor: {
      kind: 'PRINCIPAL',
      principalId: 'principal:41',
    },
    commercialSettingsDecision: {
      decisionRef: 'commerce-settings-decision:41',
      decisionRevision: 'commerce-settings-decision-r41',
    },
    contextRef: 'commerce-purchasing-context:41',
    contextRevision: 'customer-context:41',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:41',
      resolutionRevision: 'purchase-currency-resolution-r41',
    },
    subject: {
      authorizationSubject: { kind: 'RETAIL' },
      kind: 'PROFILE',
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'retail-profile:41',
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId,
      },
    },
  },
  tenantId,
} as const;
const [decisionLine] = decision.lines;

const decodeClosed = Schema.decodeUnknownSync(PricingDecisionSchema, {
  onExcessProperty: 'error',
});
const decodeAssessment = Schema.decodeUnknownSync(PricingLineInputAssessmentSchema, {
  onExcessProperty: 'error',
});

describe('Pricing canonical decision contract', () => {
  it('uses one whole-candidate model for one or many stable purchase-demand occurrences', () => {
    expect(decodeClosed(decision)).toEqual(decision);

    const equalValuedOccurrences = {
      ...decision,
      lines: [line('demand-occurrence-1'), line('demand-occurrence-2')],
    };
    const decoded = decodeClosed(equalValuedOccurrences);

    expect(decoded.lines).toHaveLength(2);
    expect(decoded.lines.map(({ occurrenceId }) => occurrenceId)).toEqual([
      'demand-occurrence-1',
      'demand-occurrence-2',
    ]);
  });

  it('rejects an empty candidate and repeated upstream occurrence identity', () => {
    expect(() => decodeClosed({ ...decision, lines: [] })).toThrow();
    expect(() =>
      decodeClosed({
        ...decision,
        lines: [line('demand-occurrence-1'), line('demand-occurrence-1')],
      }),
    ).toThrow();
  });

  it('requires an exact concrete Variant and complete non-wildcard commercial scope', () => {
    const { variantRef: _variantRef, ...productOnlySelection } = decisionLine.catalog.selection;
    expect(() =>
      decodeClosed({
        ...decision,
        lines: [
          {
            ...decisionLine,
            catalog: { ...decisionLine.catalog, selection: productOnlySelection },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeClosed({
        ...decision,
        lines: [
          {
            ...decisionLine,
            catalog: {
              ...decisionLine.catalog,
              unitRef: { ...decisionLine.catalog.unitRef, resourceType: 'commerce.catalog.unit' },
            },
          },
        ],
      }),
    ).toThrow();

    for (const omittedDimension of ['channelId', 'marketId', 'sellingLegalEntityId'] as const) {
      const partialScope = { ...decision.commercialScope };
      Reflect.deleteProperty(partialScope, omittedDimension);
      expect(() => decodeClosed({ ...decision, commercialScope: partialScope })).toThrow();
    }

    for (const wildcardDimension of ['channelId', 'marketId', 'sellingLegalEntityId'] as const) {
      expect(() =>
        decodeClosed({
          ...decision,
          commercialScope: { ...decision.commercialScope, [wildcardDimension]: '*' },
        }),
      ).toThrow();
    }
  });

  it('uses Catalog-owned UUID Product, Variant, and Product Unit identities', () => {
    expect(() =>
      decodeClosed({
        ...decision,
        lines: [
          {
            ...decisionLine,
            catalog: {
              ...decisionLine.catalog,
              selection: {
                ...decisionLine.catalog.selection,
                productRef: { ...decisionLine.catalog.selection.productRef, resourceId: 'product-1' },
              },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeClosed({
        ...decision,
        lines: [
          {
            ...decisionLine,
            catalog: {
              ...decisionLine.catalog,
              selection: {
                ...decisionLine.catalog.selection,
                variantRef: { ...decisionLine.catalog.selection.variantRef, resourceId: 'variant-1' },
              },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeClosed({
        ...decision,
        lines: [
          {
            ...decisionLine,
            pricingBasis: {
              ...decisionLine.pricingBasis,
              unitRef: { ...decisionLine.pricingBasis.unitRef, resourceType: 'commerce.catalog.unit' },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('round-trips optional package, configuration, and Set meaning without replacing the Variant', () => {
    const richLine = line('demand-occurrence-rich', richSelection, packageRef);
    const decoded = decodeClosed({ ...decision, lines: [richLine] });

    expect(decoded.lines[0]?.catalog.selection).toEqual(richSelection);
    expect(decoded.lines[0]?.catalog.selection.variantRef).toEqual(variantRef);
    expect(decoded.lines[0]?.catalog.quantityBasis.targetRef).toEqual(packageRef);
  });

  it('keeps Catalog invalid, unverifiable, and stale inputs distinct without inventing Pricing fallbacks', () => {
    expect(
      decodeAssessment({
        catalog: { reason: 'Catalog proved the Variant is not selectable', status: 'INVALID' },
        occurrenceId: 'demand-occurrence-invalid',
      }),
    ).toMatchObject({ catalog: { status: 'INVALID' } });
    expect(
      decodeAssessment({
        catalog: { reason: 'Catalog quantity evidence is unavailable', status: 'UNVERIFIABLE' },
        occurrenceId: 'demand-occurrence-unverifiable',
      }),
    ).toMatchObject({ catalog: { status: 'UNVERIFIABLE' } });
    expect(
      decodeAssessment({
        catalog: { reason: 'Catalog evidence no longer matches Current facts', status: 'STALE' },
        occurrenceId: 'demand-occurrence-stale',
      }),
    ).toMatchObject({ catalog: { status: 'STALE' } });
  });

  it('keeps currency generalized without turning Storefront or downstream domains into selectors', () => {
    expect(
      decodeClosed({
        ...decision,
        currencyCode: 'EUR',
        purchasingContext: {
          ...decision.purchasingContext,
          currencyResolution: { ...decision.purchasingContext.currencyResolution, currencyCode: 'EUR' },
        },
      }),
    ).toMatchObject({ currencyCode: 'EUR' });
    expect(() => decodeClosed({ ...decision, currencyCode: 'czk' })).toThrow();
    expect(() =>
      decodeClosed({
        ...decision,
        commercialScope: { ...decision.commercialScope, storefrontId: 'storefront-cz' },
      }),
    ).toThrow();
    expect(() => decodeClosed({ ...decision, orderId: 'order-1' })).toThrow();
    expect(() => decodeClosed({ ...decision, taxAmount: '21.00' })).toThrow();
  });

  it('requires explicit pricing basis and Catalog handoff rather than defaulting or converting', () => {
    const { pricingBasis: _pricingBasis, ...lineWithoutPricingBasis } = decisionLine;
    expect(() => decodeClosed({ ...decision, lines: [lineWithoutPricingBasis] })).toThrow();
    const { catalog: _catalog, ...lineWithoutCatalogHandoff } = decisionLine;
    expect(() => decodeClosed({ ...decision, lines: [lineWithoutCatalogHandoff] })).toThrow();
    expect(() =>
      decodeClosed({
        ...decision,
        lines: [{ ...decisionLine, pricingBasis: { ...decisionLine.pricingBasis, quantity: '0' } }],
      }),
    ).toThrow();
    expect(() =>
      decodeClosed({
        ...decision,
        lines: [
          {
            ...decisionLine,
            pricingBasis: {
              ...decisionLine.pricingBasis,
              unitRef: { ...productUnitRef, resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('requires one owner-bound purchasing subject, actor, access decision, settings decision, and currency resolution', () => {
    const guestEvidenceRef = 'guest-evidence:41';
    const guestSessionRef = 'guest-session:41';
    const guestContext = {
      ...decision.purchasingContext,
      actor: { guestEvidenceRef, guestSessionRef, kind: 'GUEST' as const },
      subject: { guestEvidenceRef, guestSessionRef, kind: 'GUEST' as const },
    };

    expect(decodeClosed({ ...decision, purchasingContext: guestContext })).toMatchObject({
      purchasingContext: { actor: { kind: 'GUEST' }, subject: { kind: 'GUEST' } },
    });
    expect(() =>
      decodeClosed({
        ...decision,
        purchasingContext: {
          ...guestContext,
          actor: { ...guestContext.actor, guestSessionRef: 'guest-session:different' },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeClosed({
        ...decision,
        purchasingContext: {
          ...decision.purchasingContext,
          currencyResolution: { ...decision.purchasingContext.currencyResolution, currencyCode: 'EUR' },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeClosed({
        ...decision,
        purchasingContext: {
          contextRef: decision.purchasingContext.contextRef,
          contextRevision: decision.purchasingContext.contextRevision,
        },
      }),
    ).toThrow();
  });

  it('accepts an explicit Catalog rounding result without calculating it inside Pricing', () => {
    const rounded = {
      ...decisionLine,
      catalog: {
        ...decisionLine.catalog,
        quantity: {
          ...decisionLine.catalog.quantity,
          changed: true,
          notice: 'ROUNDED' as const,
          requested: '2.5',
          resulting: '3',
        },
      },
    };
    expect(decodeClosed({ ...decision, lines: [rounded] }).lines[0]?.catalog.quantity).toMatchObject({
      requested: '2.5',
      resulting: '3',
    });
  });
});

const completeness = {
  observedAt: '2026-09-22T10:00:01.000Z',
  ownerRevision: 'pricing-price-set:17',
  scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-exact-key:1' },
};

const exactKey = {
  commercialScope: decision.commercialScope,
  currencyCode: decision.currencyCode,
  exactPredicateRef: 'pricing-exact-key:1',
  groupSelector: { kind: 'NO_GROUP' as const },
  pricingBasis: decisionLine.pricingBasis,
  selection: decisionLine.catalog.selection,
};

const currencySupportCompleteness = {
  observedAt: '2026-09-22T10:00:01.000Z',
  ownerRevision: '99999999-9999-4999-8999-999999999998',
  scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-currency-support:tenant' },
};
const currencySupportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '99999999-9999-4999-8999-999999999999',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const currencySupportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: currencySupportCompleteness.ownerRevision,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: currencySupportRootRef.resourceId,
  tenantId,
};

const materialBinding = (
  kind:
    | 'ABSENCE'
    | 'CATALOG_HANDOFF'
    | 'CATALOG_HIERARCHY'
    | 'CONTRIBUTION'
    | 'CURRENCY_SUPPORT'
    | 'PRICE'
    | 'TIER'
    | 'ZERO_FLOOR',
  identityRef: string,
  revisionRef: string,
  exactPredicateRef: string,
  completenessEvidence: typeof completeness | typeof currencySupportCompleteness,
) => ({ completenessEvidence, exactPredicateRef, identityRef, kind, revisionRef });

const proof = {
  currencySupport: {
    completenessEvidence: currencySupportCompleteness,
    currentnessEvidence: {
      evaluatedAt: decision.operationTime,
      evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
      observedAt: '2026-09-22T10:00:01.000Z',
      revalidatedAt: '2026-09-22T10:00:02.000Z',
      scheduleRevision: 3,
      supportRevisionRef: currencySupportRevisionRef,
      supportRootRef: currencySupportRootRef,
    },
    effectiveAt: decision.operationTime,
    effectivePeriod: {
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      effectiveTo: null,
    },
    factProofs: [
      {
        factRef: currencySupportRootRef.resourceId,
        factRevisionRef: currencySupportRevisionRef.resourceId,
        verificationRef: 'pricing-currency-support-verification:3',
      },
    ],
    generation: 3,
    observedAt: '2026-09-22T10:00:01.000Z',
    outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
    pricingRevision: 'pricing-currency-support:3',
    scheduleRevision: 3,
    supportedCurrencies: ['CZK'],
    supportRevisionRef: currencySupportRevisionRef,
    supportRootRef: currencySupportRootRef,
    tenantId,
    verificationRef: 'pricing-currency-support-verification:3',
  },
  currentness: {
    materialBindings: [
      materialBinding(
        'CATALOG_HANDOFF',
        'demand-occurrence-1',
        decisionLine.catalog.ownerRevision,
        decisionLine.catalog.completeness.scope.predicateRef,
        decisionLine.catalog.completeness,
      ),
      materialBinding(
        'CATALOG_HIERARCHY',
        'demand-occurrence-1',
        decisionLine.catalog.hierarchyRevision,
        decisionLine.catalog.completeness.scope.predicateRef,
        decisionLine.catalog.completeness,
      ),
      materialBinding(
        'CURRENCY_SUPPORT',
        tenantId,
        currencySupportCompleteness.ownerRevision,
        'pricing-currency-support:tenant',
        currencySupportCompleteness,
      ),
      materialBinding('PRICE', 'pricing-price:base', 'pricing-price:17', 'pricing-exact-key:1', completeness),
    ],
    status: 'CURRENT' as const,
    verifiedAt: '2026-09-22T10:00:01.000Z',
  },
  effectiveAt: decision.operationTime,
  observedAt: '2026-09-22T10:00:01.000Z',
};

const absenceProof = {
  ...proof,
  currentness: {
    ...proof.currentness,
    materialBindings: [
      ...proof.currentness.materialBindings.filter(({ kind }) => kind !== 'PRICE'),
      materialBinding(
        'ABSENCE',
        exactKey.exactPredicateRef,
        completeness.ownerRevision,
        exactKey.exactPredicateRef,
        completeness,
      ),
    ],
  },
};

const resolvedLine = {
  contributionAssessments: [],
  finalPreTaxAmount: { amount: '0', currencyCode: 'CZK' },
  floorGuard: {
    floorDelta: { amount: '0', currencyCode: 'CZK' },
    kind: 'NOT_REQUIRED' as const,
    rawPreTaxAmount: { amount: '0', currencyCode: 'CZK' },
  },
  input: decisionLine,
  lookup: {
    completenessEvidence: completeness,
    exactKey,
    kind: 'NO_GROUP_RESOLVED' as const,
    priceRef: 'pricing-price:base',
    priceRevision: 'pricing-price:17',
  },
  preRoundedPreTaxAmount: { amount: '0', currencyCode: 'CZK' },
  tierContributions: [],
  unitPrice: { amount: '0', currencyCode: 'CZK' },
};

const resolvedOutcome = {
  decision,
  outcome: 'PRICE_RESOLVED' as const,
  proof,
  result: {
    currencyCode: 'CZK',
    lines: [resolvedLine],
    monetaryBoundary: 'PRE_TAX' as const,
    rounding: { increment: '0.01', mode: 'HALF_UP' as const },
    total: { amount: '0', currencyCode: 'CZK' },
    totalMethod: 'EXACT_SUM_OF_ROUNDED_LINES' as const,
  },
};

const candidate = {
  candidateRef: 'pricing-candidate:1',
  occurrenceIds: ['demand-occurrence-1'],
};

const decodeOutcome = Schema.decodeUnknownSync(PricingDecisionOutcomeSchema, {
  onExcessProperty: 'error',
});

describe('Pricing typed decision outcomes', () => {
  it('closes the public decision vocabulary to exactly six outcomes', () => {
    expect(Schema.decodeSync(PricingDecisionOutcomeKindSchema)('PRICE_RESOLVED')).toBe('PRICE_RESOLVED');
    expect(Schema.decodeSync(PricingDecisionOutcomeKindSchema)('NO_APPLICABLE_PRICE')).toBe('NO_APPLICABLE_PRICE');
    expect(Schema.decodeSync(PricingDecisionOutcomeKindSchema)('PRICING_CONFIGURATION_ERROR')).toBe(
      'PRICING_CONFIGURATION_ERROR',
    );
    expect(Schema.decodeSync(PricingDecisionOutcomeKindSchema)('PRICING_CONFLICT')).toBe('PRICING_CONFLICT');
    expect(Schema.decodeSync(PricingDecisionOutcomeKindSchema)('PRICING_STALE')).toBe('PRICING_STALE');
    expect(Schema.decodeSync(PricingDecisionOutcomeKindSchema)('PRICING_INDETERMINATE')).toBe('PRICING_INDETERMINATE');
    expect(() => Schema.decodeUnknownSync(PricingDecisionOutcomeKindSchema)('SUPPORTED_CURRENCIES_CURRENT')).toThrow();
    expect(() => Schema.decodeUnknownSync(PricingDecisionOutcomeKindSchema)('APPLIED')).toThrow();
  });

  it('keeps a legitimate zero price distinct from owner-proven absence', () => {
    expect(decodeOutcome(resolvedOutcome)).toMatchObject({ outcome: 'PRICE_RESOLVED' });

    const absence = {
      decision,
      lookups: [
        {
          lookup: {
            absenceEvidence: completeness,
            exactKey,
            kind: 'NO_GROUP_ABSENT' as const,
          },
          occurrenceId: 'demand-occurrence-1',
          status: 'ABSENT' as const,
        },
      ],
      outcome: 'NO_APPLICABLE_PRICE' as const,
      proof: absenceProof,
    };
    expect(decodeOutcome(absence)).toMatchObject({ outcome: 'NO_APPLICABLE_PRICE' });
    expect(() => decodeOutcome({ ...absence, lookups: [] })).toThrow();
    expect(() =>
      decodeOutcome({
        ...resolvedOutcome,
        proof: {
          ...resolvedOutcome.proof,
          currentness: {
            ...resolvedOutcome.proof.currentness,
            materialBindings: [
              ...resolvedOutcome.proof.currentness.materialBindings,
              materialBinding(
                'ABSENCE',
                exactKey.exactPredicateRef,
                completeness.ownerRevision,
                exactKey.exactPredicateRef,
                completeness,
              ),
            ],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...absence,
        proof: {
          ...absence.proof,
          currentness: {
            ...absence.proof.currentness,
            materialBindings: [
              ...absence.proof.currentness.materialBindings,
              materialBinding(
                'PRICE',
                'pricing-price:contradictory',
                'pricing-price:contradictory-current',
                exactKey.exactPredicateRef,
                completeness,
              ),
            ],
          },
        },
      }),
    ).toThrow();
    const otherAbsenceEvidence = { ...completeness, ownerRevision: 'pricing-price-set:other-current' };
    expect(() =>
      decodeOutcome({
        ...absence,
        proof: {
          ...absence.proof,
          currentness: {
            ...absence.proof.currentness,
            materialBindings: [
              ...absence.proof.currentness.materialBindings,
              materialBinding(
                'ABSENCE',
                exactKey.exactPredicateRef,
                otherAbsenceEvidence.ownerRevision,
                exactKey.exactPredicateRef,
                otherAbsenceEvidence,
              ),
            ],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...absence,
        lookups: [
          {
            ...absence.lookups[0],
            lookup: { ...absence.lookups[0]?.lookup, absenceEvidence: otherAbsenceEvidence },
          },
        ],
        proof: {
          ...absence.proof,
          currentness: {
            ...absence.proof.currentness,
            materialBindings: [
              ...absence.proof.currentness.materialBindings,
              materialBinding(
                'ABSENCE',
                'pricing-exact-key:other-current',
                otherAbsenceEvidence.ownerRevision,
                exactKey.exactPredicateRef,
                otherAbsenceEvidence,
              ),
            ],
          },
        },
      }),
    ).toThrow();
  });

  it('keeps invalid, conflicting, stale, and unverifiable states distinct', () => {
    expect(
      decodeOutcome({
        candidate,
        outcome: 'PRICING_CONFIGURATION_ERROR',
        reasonCode: 'UNSUPPORTED_CURRENCY',
        retryable: false,
      }),
    ).toMatchObject({ reasonCode: 'UNSUPPORTED_CURRENCY' });
    expect(
      decodeOutcome({
        candidate,
        outcome: 'PRICING_CONFIGURATION_ERROR',
        reasonCode: 'CURRENCY_SUPPORT_NOT_INITIALIZED',
        retryable: false,
      }),
    ).toMatchObject({ reasonCode: 'CURRENCY_SUPPORT_NOT_INITIALIZED' });
    expect(
      decodeOutcome({
        candidate,
        currentTruthRefs: ['pricing-price:17', 'pricing-price:18'],
        outcome: 'PRICING_CONFLICT',
        reasonCode: 'COMPETING_CURRENT_EXACT_PRICES',
        retryable: false,
      }),
    ).toMatchObject({ outcome: 'PRICING_CONFLICT' });
    expect(
      decodeOutcome({
        candidate,
        outcome: 'PRICING_STALE',
        reasonCode: 'PRICE_REVISION_STALE',
        retryable: true,
        staleEvidence: {
          assessedAt: '2026-09-22T10:00:00.000Z',
          invalidatedAt: '2026-09-22T10:00:02.000Z',
          invalidatedRevision: 'pricing-price:18',
        },
      }),
    ).toMatchObject({ outcome: 'PRICING_STALE' });
    expect(
      decodeOutcome({
        candidate,
        inabilityEvidence: { attempts: 2, requiredOwnerRefs: ['pricing-price-owner'] },
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'CURRENTNESS_UNVERIFIABLE',
        retryable: true,
      }),
    ).toMatchObject({ outcome: 'PRICING_INDETERMINATE' });
    expect(
      decodeOutcome({
        candidate,
        inabilityEvidence: { attempts: 1, requiredOwnerRefs: ['pricing-currency-support-owner'] },
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'CURRENCY_SUPPORT_UNAVAILABLE',
        retryable: true,
      }),
    ).toMatchObject({ reasonCode: 'CURRENCY_SUPPORT_UNAVAILABLE' });
  });

  it('requires conflict, stale, and inability proof rather than inferring from latency or silence', () => {
    expect(() =>
      decodeOutcome({
        candidate,
        currentTruthRefs: ['pricing-price:17'],
        outcome: 'PRICING_CONFLICT',
        reasonCode: 'COMPETING_CURRENT_EXACT_PRICES',
        retryable: false,
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        candidate,
        outcome: 'PRICING_STALE',
        reasonCode: 'PRICE_REVISION_STALE',
        retryable: true,
        staleEvidence: {
          assessedAt: '2026-09-22T10:00:02.000Z',
          invalidatedAt: '2026-09-22T10:00:00.000Z',
          invalidatedRevision: 'pricing-price:18',
        },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        candidate,
        outcome: 'PRICING_STALE',
        reasonCode: 'PRICE_REVISION_STALE',
        retryable: true,
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        candidate,
        inabilityEvidence: { attempts: 0, requiredOwnerRefs: [] },
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'CURRENTNESS_UNVERIFIABLE',
        retryable: true,
      }),
    ).toThrow();
    expect(
      decodeOutcome({
        ...resolvedOutcome,
        proof: { ...proof, observedAt: '2026-09-22T10:10:00.000Z' },
      }),
    ).toMatchObject({ outcome: 'PRICE_RESOLVED' });
  });

  it('allows group fallback only with owner-proven assigned-group absence', () => {
    const assignedExactKey = {
      ...exactKey,
      groupSelector: { kind: 'ASSIGNED_GROUP' as const, priceGroupRef: 'pricing-price-group:vip' },
    };
    const vipAbsenceEvidence = {
      ...completeness,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-exact-key:vip' },
    };
    const fallback = {
      ...resolvedOutcome,
      proof: {
        ...resolvedOutcome.proof,
        currentness: {
          ...resolvedOutcome.proof.currentness,
          materialBindings: [
            ...resolvedOutcome.proof.currentness.materialBindings,
            materialBinding(
              'ABSENCE',
              'pricing-exact-key:vip',
              vipAbsenceEvidence.ownerRevision,
              'pricing-exact-key:vip',
              vipAbsenceEvidence,
            ),
          ],
        },
      },
      result: {
        ...resolvedOutcome.result,
        lines: [
          {
            ...resolvedLine,
            lookup: {
              assignedGroupAttempt: {
                absenceEvidence: vipAbsenceEvidence,
                exactKey: {
                  ...assignedExactKey,
                  exactPredicateRef: 'pricing-exact-key:vip',
                },
              },
              kind: 'ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_RESOLVED' as const,
              noGroupResolution: {
                completenessEvidence: completeness,
                exactKey,
                priceRef: 'pricing-price:base',
                priceRevision: 'pricing-price:17',
              },
            },
          },
        ],
      },
    };
    expect(decodeOutcome(fallback)).toMatchObject({ outcome: 'PRICE_RESOLVED' });
    const guestEvidenceRef = 'guest-evidence:pricing';
    const guestSessionRef = 'guest-session:pricing';
    const guestDecision = {
      ...decision,
      purchasingContext: {
        ...decision.purchasingContext,
        actor: { guestEvidenceRef, guestSessionRef, kind: 'GUEST' as const },
        subject: { guestEvidenceRef, guestSessionRef, kind: 'GUEST' as const },
      },
    };
    expect(decodeOutcome({ ...resolvedOutcome, decision: guestDecision })).toMatchObject({ outcome: 'PRICE_RESOLVED' });
    expect(() => decodeOutcome({ ...fallback, decision: guestDecision })).toThrow();
    expect(() =>
      decodeOutcome({
        ...fallback,
        result: {
          ...fallback.result,
          lines: [
            {
              ...fallback.result.lines[0],
              lookup: {
                ...fallback.result.lines[0]?.lookup,
                noGroupResolution: {
                  ...fallback.result.lines[0]?.lookup.noGroupResolution,
                  exactKey: assignedExactKey,
                },
              },
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...resolvedOutcome,
        result: {
          ...resolvedOutcome.result,
          lines: [
            {
              ...resolvedLine,
              lookup: {
                ...resolvedLine.lookup,
                exactKey: {
                  ...resolvedLine.lookup.exactKey,
                  selection: {
                    ...resolvedLine.lookup.exactKey.selection,
                    variantRef: {
                      ...resolvedLine.lookup.exactKey.selection.variantRef,
                      resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    },
                  },
                },
              },
            },
          ],
        },
      }),
    ).toThrow();

    const fallbackLine = fallback.result.lines.at(0);
    if (fallbackLine?.lookup.kind !== 'ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_RESOLVED') {
      throw new Error('Expected the fallback fixture to use the assigned-group fallback path');
    }
    const assignedAbsentOutcome = {
      decision,
      lookups: [
        {
          lookup: {
            assignedGroupAttempt: fallbackLine.lookup.assignedGroupAttempt,
            kind: 'ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_ABSENT' as const,
            noGroupAttempt: {
              absenceEvidence: completeness,
              exactKey,
            },
          },
          occurrenceId: 'demand-occurrence-1',
          status: 'ABSENT' as const,
        },
      ],
      outcome: 'NO_APPLICABLE_PRICE' as const,
      proof: {
        ...fallback.proof,
        currentness: {
          ...fallback.proof.currentness,
          materialBindings: [
            ...fallback.proof.currentness.materialBindings.filter(({ kind }) => kind !== 'PRICE'),
            materialBinding(
              'ABSENCE',
              exactKey.exactPredicateRef,
              completeness.ownerRevision,
              exactKey.exactPredicateRef,
              completeness,
            ),
          ],
        },
      },
    };
    expect(decodeOutcome(assignedAbsentOutcome)).toMatchObject({ outcome: 'NO_APPLICABLE_PRICE' });
    const [assignedAbsentAssessment] = assignedAbsentOutcome.lookups;
    expect(() =>
      decodeOutcome({
        ...assignedAbsentOutcome,
        lookups: [
          {
            ...assignedAbsentAssessment,
            lookup: {
              ...assignedAbsentAssessment?.lookup,
              noGroupAttempt: {
                ...assignedAbsentAssessment?.lookup.noGroupAttempt,
                absenceEvidence: {
                  ...completeness,
                  ownerRevision: 'pricing-absence:unbound',
                },
              },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('binds the complete Catalog selection and READY handoff without partial identity comparisons', () => {
    const richInput = line('demand-occurrence-rich', richSelection, packageRef);
    const richDecision = { ...decision, lines: [richInput] };
    const richPriceEvidence = {
      ...completeness,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-exact-key:rich' },
    };
    const richOutcome = {
      ...resolvedOutcome,
      decision: richDecision,
      proof: {
        ...resolvedOutcome.proof,
        currentness: {
          ...resolvedOutcome.proof.currentness,
          materialBindings: [
            ...resolvedOutcome.proof.currentness.materialBindings.filter(
              ({ kind }) => kind !== 'CATALOG_HANDOFF' && kind !== 'CATALOG_HIERARCHY' && kind !== 'PRICE',
            ),
            materialBinding(
              'CATALOG_HANDOFF',
              'demand-occurrence-rich',
              richInput.catalog.ownerRevision,
              richInput.catalog.completeness.scope.predicateRef,
              richInput.catalog.completeness,
            ),
            materialBinding(
              'CATALOG_HIERARCHY',
              'demand-occurrence-rich',
              richInput.catalog.hierarchyRevision,
              richInput.catalog.completeness.scope.predicateRef,
              richInput.catalog.completeness,
            ),
            materialBinding(
              'PRICE',
              'pricing-price:rich',
              'pricing-price:17',
              'pricing-exact-key:rich',
              richPriceEvidence,
            ),
          ],
        },
      },
      result: {
        ...resolvedOutcome.result,
        lines: [
          {
            ...resolvedLine,
            input: richInput,
            lookup: {
              ...resolvedLine.lookup,
              completenessEvidence: richPriceEvidence,
              exactKey: {
                ...exactKey,
                exactPredicateRef: 'pricing-exact-key:rich',
                pricingBasis: richInput.pricingBasis,
                selection: richSelection,
              },
              priceRef: 'pricing-price:rich',
            },
          },
        ],
      },
    };
    expect(decodeOutcome(richOutcome)).toMatchObject({ outcome: 'PRICE_RESOLVED' });

    const outputLine = richOutcome.result.lines.at(0);
    if (outputLine === undefined) {
      throw new Error('Expected the rich outcome fixture to contain one line');
    }
    const mutations = [
      {
        ...outputLine,
        input: {
          ...outputLine.input,
          catalog: {
            ...outputLine.input.catalog,
            selection: {
              ...richSelection,
              packageOption: {
                ...richSelection.packageOption,
                contentRevision: { ...richSelection.packageOption.contentRevision, revision: 999 },
              },
            },
          },
        },
      },
      {
        ...outputLine,
        input: {
          ...outputLine.input,
          catalog: {
            ...outputLine.input.catalog,
            selection: {
              ...richSelection,
              configuration: {
                ...richSelection.configuration,
                choices: [{ choiceKey: 'finish', value: 'red' }],
              },
            },
          },
        },
      },
      {
        ...outputLine,
        input: {
          ...outputLine.input,
          catalog: {
            ...outputLine.input.catalog,
            selection: {
              ...richSelection,
              setComposition: { ...richSelection.setComposition, revision: 999 },
            },
          },
        },
      },
      {
        ...outputLine,
        input: {
          ...outputLine.input,
          catalog: { ...outputLine.input.catalog, hierarchyRevision: 'catalog-hierarchy:999' },
        },
      },
    ];
    for (const mutatedLine of mutations) {
      expect(() =>
        decodeOutcome({
          ...richOutcome,
          result: { ...richOutcome.result, lines: [mutatedLine] },
        }),
      ).toThrow();
    }
  });

  it('requires exhaustive ordered lookup assessments before returning no applicable price', () => {
    const twoLineDecision = {
      ...decision,
      lines: [line('demand-occurrence-1'), line('demand-occurrence-2')],
    };
    const resolvedAssessment = {
      lookup: resolvedLine.lookup,
      occurrenceId: 'demand-occurrence-1',
      status: 'RESOLVED' as const,
    };
    const secondExactKey = { ...exactKey, exactPredicateRef: 'pricing-exact-key:2' };
    const secondAbsenceEvidence = {
      ...completeness,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-exact-key:2' },
    };
    const absentAssessment = {
      lookup: {
        absenceEvidence: secondAbsenceEvidence,
        exactKey: secondExactKey,
        kind: 'NO_GROUP_ABSENT' as const,
      },
      occurrenceId: 'demand-occurrence-2',
      status: 'ABSENT' as const,
    };
    const exhaustive = {
      decision: twoLineDecision,
      lookups: [resolvedAssessment, absentAssessment],
      outcome: 'NO_APPLICABLE_PRICE' as const,
      proof: {
        ...proof,
        currentness: {
          ...proof.currentness,
          materialBindings: [
            ...proof.currentness.materialBindings,
            materialBinding(
              'CATALOG_HANDOFF',
              'demand-occurrence-2',
              decisionLine.catalog.ownerRevision,
              decisionLine.catalog.completeness.scope.predicateRef,
              decisionLine.catalog.completeness,
            ),
            materialBinding(
              'CATALOG_HIERARCHY',
              'demand-occurrence-2',
              decisionLine.catalog.hierarchyRevision,
              decisionLine.catalog.completeness.scope.predicateRef,
              decisionLine.catalog.completeness,
            ),
            materialBinding(
              'ABSENCE',
              secondExactKey.exactPredicateRef,
              secondAbsenceEvidence.ownerRevision,
              secondExactKey.exactPredicateRef,
              secondAbsenceEvidence,
            ),
          ],
        },
      },
    };
    expect(decodeOutcome(exhaustive)).toMatchObject({ outcome: 'NO_APPLICABLE_PRICE' });
    expect(() => decodeOutcome({ ...exhaustive, lookups: [absentAssessment] })).toThrow();
    expect(() =>
      decodeOutcome({
        ...exhaustive,
        lookups: [resolvedAssessment, { ...resolvedAssessment, occurrenceId: 'demand-occurrence-2' }],
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...exhaustive,
        lookups: [{ ...resolvedAssessment, unitPrice: { amount: '1', currencyCode: 'CZK' } }, absentAssessment],
      }),
    ).toThrow();
  });

  it('enforces signs and requires complete authorization evidence for a zero-floor clamp', () => {
    expect(() =>
      decodeOutcome({
        ...resolvedOutcome,
        result: {
          ...resolvedOutcome.result,
          lines: [{ ...resolvedLine, unitPrice: { amount: '-1', currencyCode: 'CZK' } }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...resolvedOutcome,
        result: {
          ...resolvedOutcome.result,
          lines: [
            {
              ...resolvedLine,
              floorGuard: {
                floorDelta: { amount: '1', currencyCode: 'CZK' },
                kind: 'NOT_REQUIRED',
                rawPreTaxAmount: { amount: '-1', currencyCode: 'CZK' },
              },
            },
          ],
        },
      }),
    ).toThrow();

    const zeroFloorEvidence = {
      ...completeness,
      ownerRevision: 'pricing-zero-floor:3',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-zero-floor:scope' },
    };
    const floored = {
      ...resolvedOutcome,
      proof: {
        ...resolvedOutcome.proof,
        currentness: {
          ...resolvedOutcome.proof.currentness,
          materialBindings: [
            ...resolvedOutcome.proof.currentness.materialBindings,
            materialBinding(
              'ZERO_FLOOR',
              'pricing-zero-floor:cz-launch',
              'pricing-zero-floor:3',
              'pricing-zero-floor:scope',
              zeroFloorEvidence,
            ),
          ],
        },
      },
      result: {
        ...resolvedOutcome.result,
        lines: [
          {
            ...resolvedLine,
            floorGuard: {
              authorization: {
                commercialScope: decision.commercialScope,
                completenessEvidence: zeroFloorEvidence,
                economicEnvelope: {
                  currencyCode: 'CZK',
                  maximumRawAmount: '0',
                  minimumRawAmount: '-10',
                },
                effectivePeriod: {
                  endsAt: '2026-09-23T00:00:00.000Z',
                  startsAt: '2026-09-22T00:00:00.000Z',
                },
                pricingBasis: decisionLine.pricingBasis,
                selection: decisionLine.catalog.selection,
                zeroFloorRef: 'pricing-zero-floor:cz-launch',
                zeroFloorRevision: 'pricing-zero-floor:3',
              },
              floorDelta: { amount: '1', currencyCode: 'CZK' },
              kind: 'AUTHORIZED_ZERO_FLOOR' as const,
              rawPreTaxAmount: { amount: '-1', currencyCode: 'CZK' },
            },
          },
        ],
      },
    };
    expect(decodeOutcome(floored)).toMatchObject({ outcome: 'PRICE_RESOLVED' });
    const appliedFee = {
      amount: { amount: '1', currencyCode: 'CZK' },
      calculation: { kind: 'PERCENTAGE' as const, percentage: '10' },
      completenessEvidence: {
        ...completeness,
        ownerRevision: 'pricing-fee-set:1',
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-fee:exact' },
      },
      effect: 'FEE' as const,
      scope: 'LINE' as const,
      sourceRef: 'pricing-fee:launch',
      sourceRevision: 'pricing-fee:1',
      status: 'APPLIED' as const,
    };
    expect(() =>
      decodeOutcome({
        ...resolvedOutcome,
        result: {
          ...resolvedOutcome.result,
          lines: [
            {
              ...resolvedLine,
              contributionAssessments: [{ ...appliedFee, amount: { amount: '-1', currencyCode: 'CZK' } }],
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...resolvedOutcome,
        result: {
          ...resolvedOutcome.result,
          lines: [
            {
              ...resolvedLine,
              contributionAssessments: [
                {
                  ...appliedFee,
                  amount: { amount: '1', currencyCode: 'CZK' },
                  effect: 'CONTRACTUAL_DISCOUNT',
                },
              ],
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...resolvedOutcome,
        result: {
          ...resolvedOutcome.result,
          lines: [
            {
              ...resolvedLine,
              contributionAssessments: [{ ...appliedFee, calculation: { kind: 'PERCENTAGE', percentage: '100.01' } }],
            },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      decodeOutcome({
        ...floored,
        result: {
          ...floored.result,
          lines: [
            {
              ...floored.result.lines[0],
              finalPreTaxAmount: { amount: '1', currencyCode: 'CZK' },
              floorGuard: {
                ...floored.result.lines[0]?.floorGuard,
                floorDelta: { amount: '2', currencyCode: 'CZK' },
              },
              preRoundedPreTaxAmount: { amount: '1', currencyCode: 'CZK' },
            },
          ],
          total: { amount: '1', currencyCode: 'CZK' },
        },
      }),
    ).toThrow();
    for (const authorizationMutation of [
      {
        effectivePeriod: {
          endsAt: '2026-09-22T09:00:00.000Z',
          startsAt: '2026-09-21T00:00:00.000Z',
        },
      },
      { commercialScope: { ...decision.commercialScope, marketId: 'unrelated-market' } },
      {
        selection: {
          ...decisionLine.catalog.selection,
          variantRef: {
            ...decisionLine.catalog.selection.variantRef,
            resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        },
      },
      {
        economicEnvelope: {
          currencyCode: 'CZK',
          maximumRawAmount: '0',
          minimumRawAmount: '-0.5',
        },
      },
    ]) {
      const flooredLine = floored.result.lines.at(0);
      if (flooredLine === undefined) {
        throw new Error('Expected the floored outcome fixture to contain one line');
      }
      expect(() =>
        decodeOutcome({
          ...floored,
          result: {
            ...floored.result,
            lines: [
              {
                ...flooredLine,
                floorGuard: {
                  ...flooredLine?.floorGuard,
                  authorization: {
                    ...flooredLine?.floorGuard.authorization,
                    ...authorizationMutation,
                  },
                },
              },
            ],
          },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeOutcome({
        ...floored,
        proof: {
          ...floored.proof,
          currentness: {
            ...floored.proof.currentness,
            materialBindings: floored.proof.currentness.materialBindings.filter(({ kind }) => kind !== 'ZERO_FLOOR'),
          },
        },
      }),
    ).toThrow();
    const otherZeroFloorEvidence = { ...zeroFloorEvidence, ownerRevision: 'pricing-zero-floor:other-current' };
    expect(() =>
      decodeOutcome({
        ...floored,
        proof: {
          ...floored.proof,
          currentness: {
            ...floored.proof.currentness,
            materialBindings: [
              ...floored.proof.currentness.materialBindings,
              materialBinding(
                'ZERO_FLOOR',
                'pricing-zero-floor:cz-launch',
                otherZeroFloorEvidence.ownerRevision,
                'pricing-zero-floor:scope',
                otherZeroFloorEvidence,
              ),
            ],
          },
        },
      }),
    ).toThrow();
    const boundFlooredLine = floored.result.lines.at(0);
    if (boundFlooredLine?.floorGuard.kind !== 'AUTHORIZED_ZERO_FLOOR') {
      throw new Error('Expected an authorized zero-floor fixture');
    }
    expect(() =>
      decodeOutcome({
        ...floored,
        proof: {
          ...floored.proof,
          currentness: {
            ...floored.proof.currentness,
            materialBindings: [
              ...floored.proof.currentness.materialBindings,
              materialBinding(
                'ZERO_FLOOR',
                'pricing-zero-floor:other',
                otherZeroFloorEvidence.ownerRevision,
                'pricing-zero-floor:scope',
                otherZeroFloorEvidence,
              ),
            ],
          },
        },
        result: {
          ...floored.result,
          lines: [
            {
              ...boundFlooredLine,
              floorGuard: {
                ...boundFlooredLine.floorGuard,
                authorization: {
                  ...boundFlooredLine.floorGuard.authorization,
                  completenessEvidence: otherZeroFloorEvidence,
                  zeroFloorRevision: otherZeroFloorEvidence.ownerRevision,
                },
              },
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('binds every material owner revision and exact predicate into Current proof', () => {
    const tierEvidence = {
      ...completeness,
      ownerRevision: 'pricing-tier-set:4',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-tier:exact' },
    };
    const feeEvidence = {
      ...completeness,
      ownerRevision: 'pricing-fee-set:1',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-fee:exact' },
    };
    const materialOutcome = {
      ...resolvedOutcome,
      proof: {
        ...resolvedOutcome.proof,
        currentness: {
          ...resolvedOutcome.proof.currentness,
          materialBindings: [
            ...resolvedOutcome.proof.currentness.materialBindings,
            materialBinding('TIER', 'pricing-tier:base', 'pricing-tier:4', 'pricing-tier:exact', tierEvidence),
            materialBinding('CONTRIBUTION', 'pricing-fee:launch', 'pricing-fee:1', 'pricing-fee:exact', feeEvidence),
          ],
        },
      },
      result: {
        ...resolvedOutcome.result,
        lines: [
          {
            ...resolvedLine,
            contributionAssessments: [
              {
                amount: { amount: '0', currencyCode: 'CZK' },
                calculation: { kind: 'FIXED' as const },
                completenessEvidence: feeEvidence,
                effect: 'FEE' as const,
                scope: 'LINE' as const,
                sourceRef: 'pricing-fee:launch',
                sourceRevision: 'pricing-fee:1',
                status: 'APPLIED' as const,
              },
            ],
            tierContributions: [
              {
                amount: { amount: '0', currencyCode: 'CZK' },
                completenessEvidence: tierEvidence,
                tierRef: 'pricing-tier:base',
                tierRevision: 'pricing-tier:4',
              },
            ],
          },
        ],
      },
    };
    expect(decodeOutcome(materialOutcome)).toMatchObject({ outcome: 'PRICE_RESOLVED' });
    for (const currentRefToRemove of [
      'catalog-quantity:17',
      'catalog-hierarchy:9',
      currencySupportCompleteness.ownerRevision,
      'pricing-price:17',
      'pricing-tier:4',
      'pricing-fee:1',
    ]) {
      expect(() =>
        decodeOutcome({
          ...materialOutcome,
          proof: {
            ...materialOutcome.proof,
            currentness: {
              ...materialOutcome.proof.currentness,
              materialBindings: materialOutcome.proof.currentness.materialBindings.filter(
                ({ revisionRef }) => revisionRef !== currentRefToRemove,
              ),
            },
          },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeOutcome({
        ...materialOutcome,
        result: {
          ...materialOutcome.result,
          lines: [
            {
              ...materialOutcome.result.lines[0],
              lookup: { ...resolvedLine.lookup, priceRevision: 'pricing-price:substituted' },
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...materialOutcome,
        proof: {
          ...materialOutcome.proof,
          currentness: {
            ...materialOutcome.proof.currentness,
            materialBindings: materialOutcome.proof.currentness.materialBindings.filter(
              ({ exactPredicateRef }) => exactPredicateRef !== 'pricing-tier:exact',
            ),
          },
        },
      }),
    ).toThrow();
    const otherCatalogEvidence = {
      ...decisionLine.catalog.completeness,
      ownerRevision: 'catalog-quantity:other-current',
    };
    const otherCurrencyEvidence = {
      ...currencySupportCompleteness,
      ownerRevision: 'pricing-currency-support:other-current',
    };
    for (const sameSlotAlternate of [
      materialBinding(
        'PRICE',
        'pricing-price:base',
        'pricing-price:other-current',
        exactKey.exactPredicateRef,
        completeness,
      ),
      materialBinding('TIER', 'pricing-tier:base', 'pricing-tier:other-current', 'pricing-tier:exact', tierEvidence),
      materialBinding(
        'CONTRIBUTION',
        'pricing-fee:launch',
        'pricing-fee:other-current',
        'pricing-fee:exact',
        feeEvidence,
      ),
      materialBinding(
        'CATALOG_HANDOFF',
        'demand-occurrence-1',
        otherCatalogEvidence.ownerRevision,
        otherCatalogEvidence.scope.predicateRef,
        otherCatalogEvidence,
      ),
      materialBinding(
        'CATALOG_HIERARCHY',
        'demand-occurrence-1',
        'catalog-hierarchy:other-current',
        decisionLine.catalog.completeness.scope.predicateRef,
        decisionLine.catalog.completeness,
      ),
      materialBinding(
        'CURRENCY_SUPPORT',
        tenantId,
        otherCurrencyEvidence.ownerRevision,
        otherCurrencyEvidence.scope.predicateRef,
        otherCurrencyEvidence,
      ),
    ]) {
      expect(() =>
        decodeOutcome({
          ...materialOutcome,
          proof: {
            ...materialOutcome.proof,
            currentness: {
              ...materialOutcome.proof.currentness,
              materialBindings: [...materialOutcome.proof.currentness.materialBindings, sameSlotAlternate],
            },
          },
        }),
      ).toThrow();
    }
    const crossCurrentProof = {
      ...materialOutcome.proof,
      currentness: {
        ...materialOutcome.proof.currentness,
        materialBindings: [
          ...materialOutcome.proof.currentness.materialBindings,
          materialBinding(
            'PRICE',
            'pricing-price:other',
            'pricing-price:other-current',
            exactKey.exactPredicateRef,
            completeness,
          ),
          materialBinding(
            'TIER',
            'pricing-tier:other',
            'pricing-tier:other-current',
            'pricing-tier:exact',
            tierEvidence,
          ),
          materialBinding(
            'CONTRIBUTION',
            'pricing-fee:other',
            'pricing-fee:other-current',
            'pricing-fee:exact',
            feeEvidence,
          ),
          materialBinding(
            'CATALOG_HANDOFF',
            'demand-occurrence-other',
            otherCatalogEvidence.ownerRevision,
            otherCatalogEvidence.scope.predicateRef,
            otherCatalogEvidence,
          ),
          materialBinding(
            'CATALOG_HIERARCHY',
            'demand-occurrence-other',
            'catalog-hierarchy:other-current',
            decisionLine.catalog.completeness.scope.predicateRef,
            decisionLine.catalog.completeness,
          ),
          materialBinding(
            'CURRENCY_SUPPORT',
            'tenant-other',
            otherCurrencyEvidence.ownerRevision,
            otherCurrencyEvidence.scope.predicateRef,
            otherCurrencyEvidence,
          ),
        ],
      },
    };
    for (const substitutedLine of [
      {
        ...materialOutcome.result.lines[0],
        lookup: { ...resolvedLine.lookup, priceRevision: 'pricing-price:other-current' },
      },
      {
        ...materialOutcome.result.lines[0],
        tierContributions: [
          {
            ...materialOutcome.result.lines[0]?.tierContributions[0],
            tierRevision: 'pricing-tier:other-current',
          },
        ],
      },
      {
        ...materialOutcome.result.lines[0],
        contributionAssessments: [
          {
            ...materialOutcome.result.lines[0]?.contributionAssessments[0],
            sourceRevision: 'pricing-fee:other-current',
          },
        ],
      },
    ]) {
      expect(() =>
        decodeOutcome({
          ...materialOutcome,
          proof: crossCurrentProof,
          result: { ...materialOutcome.result, lines: [substitutedLine] },
        }),
      ).toThrow();
    }

    const ownerSubstitutedCatalog = {
      ...decisionLine.catalog,
      completeness: otherCatalogEvidence,
      ownerRevision: otherCatalogEvidence.ownerRevision,
    };
    const ownerSubstitutedLine = { ...decisionLine, catalog: ownerSubstitutedCatalog };
    expect(decodeClosed({ ...decision, lines: [ownerSubstitutedLine] })).toMatchObject({
      lines: [{ catalog: { ownerRevision: otherCatalogEvidence.ownerRevision } }],
    });
    expect(() =>
      decodeOutcome({
        ...materialOutcome,
        decision: { ...decision, lines: [ownerSubstitutedLine] },
        proof: crossCurrentProof,
        result: {
          ...materialOutcome.result,
          lines: [{ ...materialOutcome.result.lines[0], input: ownerSubstitutedLine }],
        },
      }),
    ).toThrow();
    const hierarchySubstitutedCatalog = {
      ...decisionLine.catalog,
      hierarchyRevision: 'catalog-hierarchy:other-current',
    };
    const hierarchySubstitutedLine = { ...decisionLine, catalog: hierarchySubstitutedCatalog };
    expect(decodeClosed({ ...decision, lines: [hierarchySubstitutedLine] })).toMatchObject({
      lines: [{ catalog: { hierarchyRevision: 'catalog-hierarchy:other-current' } }],
    });
    expect(() =>
      decodeOutcome({
        ...materialOutcome,
        decision: { ...decision, lines: [hierarchySubstitutedLine] },
        proof: crossCurrentProof,
        result: {
          ...materialOutcome.result,
          lines: [{ ...materialOutcome.result.lines[0], input: hierarchySubstitutedLine }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...materialOutcome,
        proof: {
          ...crossCurrentProof,
          currencySupport: {
            ...crossCurrentProof.currencySupport,
            completenessEvidence: otherCurrencyEvidence,
            pricingRevision: otherCurrencyEvidence.ownerRevision,
          },
        },
      }),
    ).toThrow();
  });

  it('proves the retained pre-rounded basis was rounded HALF_UP to a CZK cent', () => {
    const rounded = {
      ...resolvedOutcome,
      result: {
        ...resolvedOutcome.result,
        lines: [
          {
            ...resolvedLine,
            finalPreTaxAmount: { amount: '1.01', currencyCode: 'CZK' },
            floorGuard: {
              ...resolvedLine.floorGuard,
              rawPreTaxAmount: { amount: '1.005', currencyCode: 'CZK' },
            },
            preRoundedPreTaxAmount: { amount: '1.005', currencyCode: 'CZK' },
          },
        ],
        total: { amount: '1.01', currencyCode: 'CZK' },
      },
    };
    expect(decodeOutcome(rounded)).toMatchObject({ outcome: 'PRICE_RESOLVED' });
    for (const invalidFinalAmount of ['1', '1.001']) {
      expect(() =>
        decodeOutcome({
          ...rounded,
          result: {
            ...rounded.result,
            lines: [
              {
                ...rounded.result.lines[0],
                finalPreTaxAmount: { amount: invalidFinalAmount, currencyCode: 'CZK' },
              },
            ],
            total: { amount: invalidFinalAmount, currencyCode: 'CZK' },
          },
        }),
      ).toThrow();
    }
  });

  it('keeps the outcome contract currency-general without activating another Launch currency', () => {
    const eurDecision = {
      ...decision,
      currencyCode: 'EUR',
      purchasingContext: {
        ...decision.purchasingContext,
        currencyResolution: { ...decision.purchasingContext.currencyResolution, currencyCode: 'EUR' },
      },
    };
    const eurMoney = { amount: '0', currencyCode: 'EUR' };
    const eurLine = {
      ...resolvedLine,
      finalPreTaxAmount: eurMoney,
      floorGuard: {
        ...resolvedLine.floorGuard,
        floorDelta: eurMoney,
        rawPreTaxAmount: eurMoney,
      },
      lookup: {
        ...resolvedLine.lookup,
        exactKey: { ...resolvedLine.lookup.exactKey, currencyCode: 'EUR' },
      },
      preRoundedPreTaxAmount: eurMoney,
      unitPrice: eurMoney,
    };
    expect(
      decodeOutcome({
        ...resolvedOutcome,
        decision: eurDecision,
        proof: {
          ...resolvedOutcome.proof,
          currencySupport: {
            ...resolvedOutcome.proof.currencySupport,
            supportedCurrencies: ['EUR'],
          },
        },
        result: {
          ...resolvedOutcome.result,
          currencyCode: 'EUR',
          lines: [eurLine],
          total: eurMoney,
        },
      }),
    ).toMatchObject({ outcome: 'PRICE_RESOLVED', result: { currencyCode: 'EUR' } });
  });

  it('preserves every occurrence and rejects an invented line or an inexact total', () => {
    const twoLineDecision = {
      ...decision,
      lines: [line('demand-occurrence-1'), line('demand-occurrence-2')],
    };
    const twoLineOutcome = {
      ...resolvedOutcome,
      decision: twoLineDecision,
      proof: {
        ...resolvedOutcome.proof,
        currentness: {
          ...resolvedOutcome.proof.currentness,
          materialBindings: [
            ...resolvedOutcome.proof.currentness.materialBindings,
            materialBinding(
              'CATALOG_HANDOFF',
              'demand-occurrence-2',
              decisionLine.catalog.ownerRevision,
              decisionLine.catalog.completeness.scope.predicateRef,
              decisionLine.catalog.completeness,
            ),
            materialBinding(
              'CATALOG_HIERARCHY',
              'demand-occurrence-2',
              decisionLine.catalog.hierarchyRevision,
              decisionLine.catalog.completeness.scope.predicateRef,
              decisionLine.catalog.completeness,
            ),
          ],
        },
      },
      result: {
        ...resolvedOutcome.result,
        lines: [resolvedLine, { ...resolvedLine, input: twoLineDecision.lines[1] }],
      },
    };
    expect(decodeOutcome(twoLineOutcome)).toMatchObject({
      outcome: 'PRICE_RESOLVED',
      result: { lines: twoLineOutcome.result.lines },
    });
    expect(() =>
      decodeOutcome({
        ...twoLineOutcome,
        result: { ...twoLineOutcome.result, lines: [resolvedLine] },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        ...resolvedOutcome,
        result: { ...resolvedOutcome.result, total: { amount: '0.01', currencyCode: 'CZK' } },
      }),
    ).toThrow();
  });
});
