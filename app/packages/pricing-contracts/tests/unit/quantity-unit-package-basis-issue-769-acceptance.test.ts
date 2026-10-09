import {
  PricingQuantityBasisAssessmentInputSchema,
  PricingQuantityBasisAssessmentSchema,
} from '../../src/domain/quantity-unit-package-basis.ts';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const tenantId = '11111111-1111-4111-8111-111111111111';
const observedAt = '2026-09-27T12:00:00.000Z';
const effectiveAt = observedAt;
const validUntil = '2026-09-27T12:05:00.000Z';

const catalogRef = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = catalogRef('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const packageRef = catalogRef('commerce.catalog.package-definition', '44444444-4444-4444-8444-444444444444');
const pieceProductUnitRef = catalogRef('commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555551');
const packageProductUnitRef = catalogRef('commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555552');
const pieceUnitRef = catalogRef('commerce.catalog.unit', '66666666-6666-4666-8666-666666666661');
const packageUnitRef = catalogRef('commerce.catalog.unit', '66666666-6666-4666-8666-666666666662');
const unrelatedUnitRef = catalogRef('commerce.catalog.unit', '66666666-6666-4666-8666-666666666663');
const configurationDefinitionRef = catalogRef(
  'commerce.catalog.configuration-definition',
  '77777777-7777-4777-8777-777777777771',
);
const setCompositionRef = catalogRef('commerce.catalog.set-composition', '77777777-7777-4777-8777-777777777772');
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};

type CatalogRef = ReturnType<typeof catalogRef>;

const revision = (resourceRef: CatalogRef, value: number, revisionId?: string) => {
  const reference = { resourceRef, revision: value };
  return revisionId === undefined ? reference : { ...reference, revisionId };
};

interface SelectionFixture {
  configuration?: {
    choices: { choiceKey: string; value: string }[];
    definition: ReturnType<typeof revision>;
    productRef: CatalogRef;
    variantRef: CatalogRef;
  };
  packageOption?: {
    contentRevision: ReturnType<typeof revision>;
    optionRef: CatalogRef;
  };
  productRef: CatalogRef;
  setComposition?: ReturnType<typeof revision>;
  variantRef: CatalogRef;
}

const selection = (
  options: {
    readonly configurationValue?: string;
    readonly packageRevision?: number;
    readonly setRevision?: number;
  } = {},
): SelectionFixture => {
  const selected: SelectionFixture = { productRef, variantRef };
  if (options.configurationValue !== undefined) {
    selected.configuration = {
      choices: [{ choiceKey: 'measured-length', value: options.configurationValue }],
      definition: revision(configurationDefinitionRef, 6),
      productRef,
      variantRef,
    };
  }
  if (options.packageRevision !== undefined) {
    selected.packageOption = {
      contentRevision: revision(packageRef, options.packageRevision),
      optionRef: packageRef,
    };
  }
  if (options.setRevision !== undefined) {
    selected.setComposition = revision(
      setCompositionRef,
      options.setRevision,
      `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${options.setRevision}`,
    );
  }
  return selected;
};

type ExactSelection = SelectionFixture;

const basisFor = (exactSelection: ExactSelection) => [
  { role: 'PRODUCT' as const, source: revision(productRef, 3) },
  { role: 'VARIANT' as const, source: revision(variantRef, 7) },
  {
    provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
    role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
    source: revision(productRef, 3),
  },
  ...(exactSelection.packageOption === undefined
    ? []
    : [{ role: 'PACKAGE_CONTENT' as const, source: exactSelection.packageOption.contentRevision }]),
  ...(exactSelection.configuration === undefined
    ? []
    : [{ role: 'CONFIGURATION_DEFINITION' as const, source: exactSelection.configuration.definition }]),
  ...(exactSelection.setComposition === undefined
    ? []
    : [{ role: 'SET_COMPOSITION' as const, source: exactSelection.setComposition }]),
];

const quantityBasis = (exactSelection: ExactSelection, unitRef: CatalogRef) => ({
  targetDivisibilityRevision: 3,
  targetRef: exactSelection.packageOption?.optionRef ?? exactSelection.variantRef,
  unitRef,
  unitRuleRevision: 5,
});

const handoff = (exactSelection: ExactSelection, amount: string, unitRef: CatalogRef) => ({
  completeness: {
    nextApplicabilityBoundary: validUntil,
    observedAt,
    ownerRevision: 'catalog-quantity:17',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
  },
  divisible: false,
  equivalentSelectionKey: `pricing-purpose:${variantRef.resourceId}`,
  evidence: {
    assessedAt: observedAt,
    basis: basisFor(exactSelection),
    membership: {
      attestationId: '99999999-9999-4999-8999-999999999999',
      observedAt,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      variant: revision(variantRef, 7),
    },
    purpose: 'PRICING' as const,
    selection: exactSelection,
    status: 'VALID' as const,
    validUntil,
  },
  hierarchyRevision: 'catalog-hierarchy:9',
  ownerRevision: 'catalog-quantity:17',
  quantity: {
    changed: false,
    notice: null,
    requested: amount,
    resulting: amount,
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
    step: '1',
    targetId: (exactSelection.packageOption?.optionRef ?? variantRef).resourceId,
    tenantId,
    unitId: unitRef.resourceId,
    unitRuleRevision: 5,
  },
  quantityBasis: quantityBasis(exactSelection, unitRef),
  selection: exactSelection,
  status: 'READY' as const,
  unitRef,
});

const price = (
  exactSelection: ExactSelection,
  unitRef: CatalogRef = pieceProductUnitRef,
  currencyCode: 'CZK' | 'EUR' = 'CZK',
) => ({
  identityKey: {
    catalogSelection: exactSelection,
    commercialScope: {
      channelId: 'B2C' as const,
      marketId: 'cz-launch',
      sellingLegalEntityId: 'abababab-abab-4bab-8bab-abababababab',
    },
    currencyCode,
    priceGroupSelector: { kind: 'NO_GROUP' as const },
    unitBasis: { quantity: '10', unitRef },
  },
  priceRef,
  revision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount: '100', currencyCode },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 1,
    revisionId: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
  },
});

const tier = (exactSelection: ExactSelection, unitRef = pieceProductUnitRef) => ({
  identityKey: {
    priceRef,
    quantityBasis: {
      catalogQuantityBasis: quantityBasis(exactSelection, unitRef),
      priceUnitBasis: { quantity: '10', unitRef },
    },
    thresholdQuantity: '20',
  },
  revision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryBoundary: 'PRE_TAX' as const,
    resultingUnitPrice: { amount: '90', currencyCode: 'CZK' as const },
    revision: 1,
    revisionId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
  },
});

const commonEvidence = (
  exactSelection: ExactSelection,
  requestedQuantity: string,
  requestedUnitRef: CatalogRef,
  priceEndpoint: ReturnType<typeof endpoint>,
  tierEndpoint: ReturnType<typeof endpoint>,
) => ({
  completeness: handoff(exactSelection, requestedQuantity, requestedUnitRef).completeness,
  currentness: {
    observedAt,
    ownerRevision: 'catalog-quantity:17',
    status: 'CURRENT' as const,
    validUntil,
  },
  currentnessEvidence: {
    effectiveAt,
    generation: 'catalog-quantity:17',
    observedAt,
    predicateRef: 'catalog-quantity:exact-selection',
    revalidatedAt: observedAt,
    validUntil,
    verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED' as const,
  },
  effectiveAt,
  equivalentSelectionKey: `pricing-purpose:${variantRef.resourceId}`,
  generation: 'catalog-quantity:17',
  hierarchyRevision: 'catalog-hierarchy:9',
  observedAt,
  ownerModuleId: 'commerce.catalog' as const,
  ownerRevision: 'catalog-quantity:17',
  requestedOwnerRevision: 'catalog-quantity:17',
  requestedQuantity,
  requestedQuantityBasis: quantityBasis(exactSelection, requestedUnitRef),
  requestedUnitRef,
  selection: exactSelection,
  source: 'CATALOG_OWNER_CURRENT_READ' as const,
  verificationReceipt: {
    generation: 'catalog-quantity:17',
    issuedAt: observedAt,
    ownerModuleId: 'commerce.catalog' as const,
    ownerRevision: 'catalog-quantity:17',
    predicate: {
      effectiveAt,
      price: priceEndpoint,
      requestedQuantity,
      requestedQuantityBasis: quantityBasis(exactSelection, requestedUnitRef),
      requestedUnitRef,
      selection: exactSelection,
      tier: tierEndpoint,
    },
    predicateRef: 'catalog-quantity:exact-selection',
    verificationRef: 'catalog-quantity-basis-verification:17',
  },
});

const endpoint = (exactSelection: ExactSelection, quantity: string, productUnitRef: CatalogRef) => ({
  quantity,
  quantityBasis: quantityBasis(exactSelection, productUnitRef),
});

const noConversionInput = (
  exactSelection: ExactSelection = selection(),
  amount = '20',
  currencyCode: 'CZK' | 'EUR' = 'CZK',
) => {
  const catalog = handoff(exactSelection, amount, pieceProductUnitRef);
  const sharedEndpoint = endpoint(exactSelection, amount, pieceProductUnitRef);
  const pricingEndpoint = endpoint(exactSelection, '10', pieceProductUnitRef);
  return {
    attempt: {
      catalog,
      effectiveAt,
      occurrenceId: 'purchase-demand:line-A',
      price: price(exactSelection, pieceProductUnitRef, currencyCode),
      tier: tier(exactSelection),
    },
    ownerDecision: {
      ...commonEvidence(exactSelection, amount, pieceProductUnitRef, pricingEndpoint, pricingEndpoint),
      endpoints: {
        price: pricingEndpoint,
        purchase: sharedEndpoint,
        requested: sharedEndpoint,
        tier: pricingEndpoint,
      },
      outcome: 'NO_CONVERSION_REQUIRED' as const,
    },
  };
};

const compatiblePackageInput = (
  packageRevision: number,
  packageSize: string,
  occurrenceId = 'purchase-demand:pack-A',
) => {
  const exactSelection = selection({ packageRevision });
  const catalog = handoff(exactSelection, '2', packageProductUnitRef);
  const purchase = endpoint(exactSelection, '2', packageProductUnitRef);
  const pricingQuantum = endpoint(exactSelection, '10', pieceProductUnitRef);
  const convertedQuantity = String(2 * Number(packageSize));
  return {
    attempt: {
      catalog,
      effectiveAt,
      occurrenceId,
      price: price(exactSelection),
      tier: tier(exactSelection),
    },
    ownerDecision: {
      ...commonEvidence(exactSelection, '2', packageProductUnitRef, pricingQuantum, pricingQuantum),
      endpoints: { price: pricingQuantum, purchase, requested: purchase, tier: pricingQuantum },
      mappings: [
        {
          effectiveAt,
          observedAt,
          ownerModuleId: 'commerce.catalog' as const,
          ownerRevision: 'catalog-quantity:17',
          physicalUnitRevision: revision(packageUnitRef, packageRevision),
          productUnitBasis: purchase.quantityBasis,
          role: 'PURCHASE' as const,
          source: 'CATALOG_OWNER_CURRENT_READ' as const,
        },
        {
          effectiveAt,
          observedAt,
          ownerModuleId: 'commerce.catalog' as const,
          ownerRevision: 'catalog-quantity:17',
          physicalUnitRevision: revision(pieceUnitRef, 4),
          productUnitBasis: pricingQuantum.quantityBasis,
          role: 'PRICE' as const,
          source: 'CATALOG_OWNER_CURRENT_READ' as const,
        },
      ],
      outcome: 'COMPATIBLE_CONVERSION' as const,
      steps: [
        {
          conversion: {
            denominator: '1',
            evidenceId:
              packageRevision === 10 ? 'dededede-dede-4ded-8ded-dededededed1' : 'dededede-dede-4ded-8ded-dededededed2',
            from: revision(packageUnitRef, packageRevision),
            numerator: packageSize,
            observedAt,
            ownerModuleId: 'commerce.catalog' as const,
            source: 'CATALOG_OWNER_CURRENT_READ' as const,
            to: revision(pieceUnitRef, 4),
          },
          from: 'PURCHASE' as const,
          fromQuantity: '2',
          to: 'PRICE' as const,
          toQuantity: convertedQuantity,
        },
      ],
    },
  };
};

const decodeInput = Schema.decodeUnknownSync(PricingQuantityBasisAssessmentInputSchema, {
  onExcessProperty: 'error',
});
const decodeAssessment = Schema.decodeUnknownSync(PricingQuantityBasisAssessmentSchema, {
  onExcessProperty: 'error',
});

describe('Pricing Quantity Unit and Package Basis #769 contracts', () => {
  it('binds one exact Variant, Price, Tier, SLE, Channel, Market, and unambiguous owner basis', () => {
    const decoded = decodeInput(noConversionInput());

    expect(decoded.attempt.price.identityKey).toMatchObject({
      catalogSelection: { variantRef },
      commercialScope: {
        channelId: 'B2C',
        marketId: 'cz-launch',
        sellingLegalEntityId: 'abababab-abab-4bab-8bab-abababababab',
      },
      unitBasis: { quantity: '10', unitRef: pieceProductUnitRef },
    });
    expect(decoded.attempt.tier?.identityKey).toMatchObject({
      priceRef,
      quantityBasis: {
        catalogQuantityBasis: { targetRef: variantRef, unitRef: pieceProductUnitRef },
        priceUnitBasis: { quantity: '10', unitRef: pieceProductUnitRef },
      },
    });
    expect(decoded.ownerDecision.outcome).toBe('NO_CONVERSION_REQUIRED');
  });

  it('requires exact revision-qualified package conversion evidence and keeps a pinned 10-piece basis stable', () => {
    const pinnedTen = decodeInput(compatiblePackageInput(10, '10'));
    const currentEight = decodeInput(compatiblePackageInput(11, '8'));

    expect(pinnedTen.ownerDecision).toMatchObject({
      endpoints: { price: { quantity: '10' }, purchase: { quantity: '2' } },
      outcome: 'COMPATIBLE_CONVERSION',
      steps: [{ conversion: { numerator: '10' }, fromQuantity: '2', toQuantity: '20' }],
    });
    expect(pinnedTen.attempt.price.identityKey.catalogSelection.packageOption?.contentRevision.revision).toBe(10);
    expect(currentEight.ownerDecision).toMatchObject({
      endpoints: { price: { quantity: '10' } },
      steps: [{ conversion: { numerator: '8' }, toQuantity: '16' }],
    });
    expect(pinnedTen.ownerDecision).toMatchObject({ steps: [{ toQuantity: '20' }] });
  });

  it('rejects conversion arithmetic that substitutes 3 packages for the preserved purchase Quantity 2', () => {
    const exact = compatiblePackageInput(10, '10');
    const decoded = decodeInput(exact);

    expect(decoded.ownerDecision).toMatchObject({
      endpoints: {
        price: { quantity: '10' },
        purchase: { quantity: '2' },
        tier: { quantity: '10' },
      },
      outcome: 'COMPATIBLE_CONVERSION',
      steps: [{ fromQuantity: '2', toQuantity: '20' }],
    });
    if (exact.ownerDecision.outcome !== 'COMPATIBLE_CONVERSION') {
      return;
    }
    const [step, ...remainingSteps] = exact.ownerDecision.steps;
    if (step === undefined) {
      return;
    }
    expect(() =>
      decodeInput({
        ...exact,
        ownerDecision: {
          ...exact.ownerDecision,
          steps: [{ ...step, fromQuantity: '3', toQuantity: '30' }, ...remainingSteps],
        },
      }),
    ).toThrow();
  });

  it('rejects unrelated same-Tenant physical mappings and accepts only the owner UNVERIFIABLE no-mapping path', () => {
    const exact = compatiblePackageInput(10, '10');
    const [purchaseMapping, priceMapping] = exact.ownerDecision.mappings;
    expect(purchaseMapping).toBeDefined();
    expect(priceMapping).toBeDefined();
    expect(() =>
      decodeInput({
        ...exact,
        ownerDecision: {
          ...exact.ownerDecision,
          mappings: [
            {
              ...purchaseMapping,
              physicalUnitRevision: revision(unrelatedUnitRef, 10),
            },
            priceMapping,
          ],
        },
      }),
    ).toThrow();

    const missingMapping = decodeInput({
      attempt: exact.attempt,
      ownerDecision: {
        ...commonEvidence(
          exact.attempt.catalog.selection,
          '2',
          packageProductUnitRef,
          endpoint(exact.attempt.catalog.selection, '10', pieceProductUnitRef),
          endpoint(exact.attempt.catalog.selection, '10', pieceProductUnitRef),
        ),
        outcome: 'UNVERIFIABLE',
        reason: 'Catalog has no exact Product Unit to physical Unit mapping',
      },
    });
    expect(missingMapping.ownerDecision).toMatchObject({
      outcome: 'UNVERIFIABLE',
      reason: 'Catalog has no exact Product Unit to physical Unit mapping',
    });
  });

  it('does not treat changed configuration or Set meaning as equivalent without exact owner proof', () => {
    const configured = selection({ configurationValue: '83', setRevision: 1 });
    const changedConfiguration = selection({ configurationValue: '84', setRevision: 1 });
    const changedSet = selection({ configurationValue: '83', setRevision: 2 });
    const exact = noConversionInput(configured, '3');

    expect(decodeInput(exact).attempt.catalog.selection).toEqual(configured);
    expect(() =>
      decodeInput({
        ...exact,
        ownerDecision: { ...exact.ownerDecision, selection: changedConfiguration },
      }),
    ).toThrow();
    expect(() =>
      decodeInput({
        ...exact,
        ownerDecision: { ...exact.ownerDecision, selection: changedSet },
      }),
    ).toThrow();
  });

  it('keeps configuration measured value separate from purchase Quantity', () => {
    const configured = selection({ configurationValue: '83' });
    const input = decodeInput(noConversionInput(configured, '3'));

    expect(input.attempt.catalog.selection.configuration?.choices[0]?.value).toBe('83');
    expect(input.attempt.catalog.quantity.resulting).toBe('3');
    if (input.ownerDecision.outcome !== 'NO_CONVERSION_REQUIRED') {
      throw new Error('expected no-conversion fixture');
    }
    expect(input.ownerDecision.endpoints.purchase.quantity).toBe('3');
    expect(input.ownerDecision.endpoints.price.quantity).toBe('10');
  });

  it('represents incompatible and unverifiable bases as typed failures with no guessed zero price', () => {
    const { attempt } = decodeInput(noConversionInput());
    for (const outcome of ['INCOMPATIBLE', 'INVALID', 'UNAVAILABLE', 'UNVERIFIABLE'] as const) {
      const failure =
        outcome === 'UNAVAILABLE'
          ? decodeAssessment({ attempt, outcome, reason: `${outcome} owner basis`, retryable: true })
          : decodeAssessment({ attempt, outcome, reason: `${outcome} owner basis` });
      expect(failure.outcome).toBe(outcome);
      expect(failure).not.toHaveProperty('priceQuantity');
      expect(failure).not.toHaveProperty('resultingUnitPrice');
      expect(failure).not.toHaveProperty('amount', '0');
    }
  });

  it('excludes Storefront, FX, and currency activation while retaining generalized native currency Price identity', () => {
    const eur = noConversionInput(selection(), '20', 'EUR');
    expect(decodeInput(eur).attempt.price.identityKey.currencyCode).toBe('EUR');
    expect(() => decodeInput({ ...eur, storefrontId: 'storefront-prague' })).toThrow();
    expect(() => decodeInput({ ...eur, exchangeRate: '25' })).toThrow();
    expect(() => decodeInput({ ...eur, supportedCurrencies: ['CZK', 'EUR'] })).toThrow();
  });
});
