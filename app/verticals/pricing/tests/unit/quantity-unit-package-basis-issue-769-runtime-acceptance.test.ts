import {
  PricingQuantityBasisAssessmentInputSchema,
  PricingQuantityBasisAssessmentSchema,
} from '@app/pricing-contracts/domain/quantity-unit-package-basis';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { assessPricingQuantityBasis } from '../../src/services/quantity-unit-package-basis.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const observedAt = '2026-09-27T12:00:00.000Z';
const effectiveAt = observedAt;
const validUntil = '2026-09-27T12:05:00.000Z';

const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const packageRef = ref('commerce.catalog.package-definition', '44444444-4444-4444-8444-444444444444');
const pieceProductUnitRef = ref('commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555551');
const packageProductUnitRef = ref('commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555552');
const metreProductUnitRef = ref('commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555553');
const centimetreProductUnitRef = ref('commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555554');
const pieceUnitRef = ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666661');
const packageUnitRef = ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666662');
const metreUnitRef = ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666663');
const centimetreUnitRef = ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666664');
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};

const revision = (resourceRef: ReturnType<typeof ref>, value: number) => ({ resourceRef, revision: value });
const selection = (packageRevision?: number) =>
  packageRevision === undefined
    ? { productRef, variantRef }
    : {
        packageOption: { contentRevision: revision(packageRef, packageRevision), optionRef: packageRef },
        productRef,
        variantRef,
      };
type ExactSelection = ReturnType<typeof selection>;
type ProductUnitRef = typeof pieceProductUnitRef;
type PhysicalUnitRef = typeof pieceUnitRef;

const targetFor = (exactSelection: ExactSelection) =>
  'packageOption' in exactSelection ? exactSelection.packageOption.optionRef : exactSelection.variantRef;
const basis = (exactSelection: ExactSelection, unitRef: ProductUnitRef) => ({
  targetDivisibilityRevision: 3,
  targetRef: targetFor(exactSelection),
  unitRef,
  unitRuleRevision: 5,
});
const evidenceBasis = (exactSelection: ExactSelection) => [
  { role: 'PRODUCT' as const, source: revision(productRef, 3) },
  { role: 'VARIANT' as const, source: revision(variantRef, 7) },
  {
    provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
    role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
    source: revision(productRef, 3),
  },
  ...('packageOption' in exactSelection
    ? [{ role: 'PACKAGE_CONTENT' as const, source: exactSelection.packageOption.contentRevision }]
    : []),
];

const handoff = (exactSelection: ExactSelection, amount: string, unitRef: ProductUnitRef) => ({
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
    basis: evidenceBasis(exactSelection),
    membership: {
      attestationId: '88888888-8888-4888-8888-888888888888',
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
    targetId: targetFor(exactSelection).resourceId,
    tenantId,
    unitId: unitRef.resourceId,
    unitRuleRevision: 5,
  },
  quantityBasis: basis(exactSelection, unitRef),
  selection: exactSelection,
  status: 'READY' as const,
  unitRef,
});

const price = (exactSelection: ExactSelection, unitRef: ProductUnitRef, currencyCode: 'CZK' | 'EUR' = 'CZK') => ({
  identityKey: {
    catalogSelection: exactSelection,
    commercialScope: {
      channelId: 'B2C' as const,
      marketId: 'cz-launch',
      sellingLegalEntityId: '99999999-9999-4999-8999-999999999999',
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
    revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
});

const tier = (exactSelection: ExactSelection, unitRef: ProductUnitRef, currencyCode: 'CZK' | 'EUR' = 'CZK') => ({
  identityKey: {
    priceRef,
    quantityBasis: {
      catalogQuantityBasis: basis(exactSelection, unitRef),
      priceUnitBasis: { quantity: '10', unitRef },
    },
    thresholdQuantity: '20',
  },
  revision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryBoundary: 'PRE_TAX' as const,
    resultingUnitPrice: { amount: '90', currencyCode },
    revision: 1,
    revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  },
});

const commonEvidence = (
  exactSelection: ExactSelection,
  requestedQuantity: string,
  requestedUnitRef: ProductUnitRef,
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
  requestedQuantityBasis: basis(exactSelection, requestedUnitRef),
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
      requestedQuantityBasis: basis(exactSelection, requestedUnitRef),
      requestedUnitRef,
      selection: exactSelection,
      tier: tierEndpoint,
    },
    predicateRef: 'catalog-quantity:exact-selection',
    verificationRef: 'catalog-quantity-basis-verification:17',
  },
});
const endpoint = (exactSelection: ExactSelection, quantity: string, productUnitRef: ProductUnitRef) => ({
  quantity,
  quantityBasis: basis(exactSelection, productUnitRef),
});

const conversionEvidenceId = (packageRevision?: number): string => {
  if (packageRevision === 10) {
    return 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  }
  if (packageRevision === 11) {
    return 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
  }
  return 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
};

const noConversion = (occurrenceId: string, amount = '20', currencyCode: 'CZK' | 'EUR' = 'CZK') => {
  const exactSelection = selection();
  const purchase = endpoint(exactSelection, amount, pieceProductUnitRef);
  const pricingQuantum = endpoint(exactSelection, '10', pieceProductUnitRef);
  return {
    attempt: {
      catalog: handoff(exactSelection, amount, pieceProductUnitRef),
      effectiveAt,
      occurrenceId,
      price: price(exactSelection, pieceProductUnitRef, currencyCode),
      tier: tier(exactSelection, pieceProductUnitRef, currencyCode),
    },
    ownerDecision: {
      ...commonEvidence(exactSelection, amount, pieceProductUnitRef, pricingQuantum, pricingQuantum),
      endpoints: { price: pricingQuantum, purchase, requested: purchase, tier: pricingQuantum },
      outcome: 'NO_CONVERSION_REQUIRED' as const,
    },
  };
};

const conversion = (options: {
  readonly currencyCode?: 'CZK' | 'EUR';
  readonly fromPhysicalUnitRef: PhysicalUnitRef;
  readonly fromProductUnitRef: ProductUnitRef;
  readonly fromQuantity: string;
  readonly occurrenceId: string;
  readonly packageRevision?: number;
  readonly ratio: string;
  readonly toPhysicalUnitRef: PhysicalUnitRef;
  readonly toProductUnitRef: ProductUnitRef;
  readonly toQuantity: string;
}) => {
  const exactSelection = selection(options.packageRevision);
  const purchase = endpoint(exactSelection, options.fromQuantity, options.fromProductUnitRef);
  const pricingQuantum = endpoint(exactSelection, '10', options.toProductUnitRef);
  const currencyCode = options.currencyCode ?? 'CZK';
  return {
    attempt: {
      catalog: handoff(exactSelection, options.fromQuantity, options.fromProductUnitRef),
      effectiveAt,
      occurrenceId: options.occurrenceId,
      price: price(exactSelection, options.toProductUnitRef, currencyCode),
      tier: tier(exactSelection, options.toProductUnitRef, currencyCode),
    },
    ownerDecision: {
      ...commonEvidence(
        exactSelection,
        options.fromQuantity,
        options.fromProductUnitRef,
        pricingQuantum,
        pricingQuantum,
      ),
      endpoints: { price: pricingQuantum, purchase, requested: purchase, tier: pricingQuantum },
      mappings: [
        {
          effectiveAt,
          observedAt,
          ownerModuleId: 'commerce.catalog' as const,
          ownerRevision: 'catalog-quantity:17',
          physicalUnitRevision: revision(options.fromPhysicalUnitRef, options.packageRevision ?? 4),
          productUnitBasis: purchase.quantityBasis,
          role: 'PURCHASE' as const,
          source: 'CATALOG_OWNER_CURRENT_READ' as const,
        },
        {
          effectiveAt,
          observedAt,
          ownerModuleId: 'commerce.catalog' as const,
          ownerRevision: 'catalog-quantity:17',
          physicalUnitRevision: revision(options.toPhysicalUnitRef, 4),
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
            evidenceId: conversionEvidenceId(options.packageRevision),
            from: revision(options.fromPhysicalUnitRef, options.packageRevision ?? 4),
            numerator: options.ratio,
            observedAt,
            ownerModuleId: 'commerce.catalog' as const,
            source: 'CATALOG_OWNER_CURRENT_READ' as const,
            to: revision(options.toPhysicalUnitRef, 4),
          },
          from: 'PURCHASE' as const,
          fromQuantity: options.fromQuantity,
          to: 'PRICE' as const,
          toQuantity: options.toQuantity,
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

describe('Pricing Quantity Unit and Package Basis #769 runtime acceptance', () => {
  it.effect('uses same-Unit purchase Quantity directly and never divides by non-1 Price basis quantity', () =>
    Effect.gen(function* sameUnit() {
      const result = yield* assessPricingQuantityBasis(decodeInput(noConversion('purchase-demand:loose')));

      expect(decodeAssessment(result)).toEqual(result);
      expect(result).toMatchObject({
        occurrenceId: 'purchase-demand:loose',
        outcome: 'NO_CONVERSION_REQUIRED',
        priceQuantity: { amount: '10', unitRef: pieceProductUnitRef },
        requestedQuantity: { amount: '20' },
        resultingPurchaseQuantity: { amount: '20' },
        tierQuantity: { amount: '10' },
      });
      if (result.outcome === 'NO_CONVERSION_REQUIRED') {
        expect(result.attempt.price.identityKey.unitBasis.quantity).toBe('10');
        expect(result.resultingPurchaseQuantity.amount).not.toBe(result.priceQuantity.amount);
      }
    }),
  );

  it.effect('preserves purchase Quantity 2 separately from a one-Unit Price and Tier basis quantum', () =>
    Effect.gen(function* distinctPurchaseAndPriceBasis() {
      const original = noConversion('purchase-demand:two-against-one-basis', '2');
      const exact = decodeInput({
        ...original,
        attempt: {
          ...original.attempt,
          price: {
            ...original.attempt.price,
            identityKey: {
              ...original.attempt.price.identityKey,
              unitBasis: { ...original.attempt.price.identityKey.unitBasis, quantity: '1' },
            },
          },
          tier: {
            ...original.attempt.tier,
            identityKey: {
              ...original.attempt.tier.identityKey,
              quantityBasis: {
                ...original.attempt.tier.identityKey.quantityBasis,
                priceUnitBasis: { ...original.attempt.tier.identityKey.quantityBasis.priceUnitBasis, quantity: '1' },
              },
            },
          },
        },
        ownerDecision: {
          ...original.ownerDecision,
          endpoints: {
            ...original.ownerDecision.endpoints,
            price: { ...original.ownerDecision.endpoints.price, quantity: '1' },
            tier: { ...original.ownerDecision.endpoints.tier, quantity: '1' },
          },
        },
      });
      const result = yield* assessPricingQuantityBasis(exact);

      expect(result).toMatchObject({
        outcome: 'NO_CONVERSION_REQUIRED',
        priceQuantity: { amount: '1' },
        requestedQuantity: { amount: '2' },
        resultingPurchaseQuantity: { amount: '2' },
        tierQuantity: { amount: '1' },
      });
      expect(result.attempt.price.identityKey.unitBasis.quantity).toBe('1');
      expect(result.attempt.tier?.identityKey.quantityBasis.priceUnitBasis.quantity).toBe('1');
    }),
  );

  it.effect(
    'accepts a later Catalog compatibility observation for the same effective time and requested revisions',
    () =>
      Effect.gen(function* distinctOwnerReadTimes() {
        const original = noConversion('purchase-demand:later-catalog-read', '2');
        const laterObservedAt = '2026-09-27T12:00:01.000Z';
        const laterOwnerRevision = 'catalog-quantity:18';
        const exact = decodeInput({
          ...original,
          ownerDecision: {
            ...original.ownerDecision,
            completeness: {
              ...original.ownerDecision.completeness,
              observedAt: laterObservedAt,
              ownerRevision: laterOwnerRevision,
            },
            currentness: {
              ...original.ownerDecision.currentness,
              observedAt: laterObservedAt,
              ownerRevision: laterOwnerRevision,
            },
            currentnessEvidence: {
              ...original.ownerDecision.currentnessEvidence,
              generation: laterOwnerRevision,
              observedAt: laterObservedAt,
              revalidatedAt: laterObservedAt,
            },
            generation: laterOwnerRevision,
            observedAt: laterObservedAt,
            ownerRevision: laterOwnerRevision,
            verificationReceipt: {
              ...original.ownerDecision.verificationReceipt,
              generation: laterOwnerRevision,
              issuedAt: laterObservedAt,
              ownerRevision: laterOwnerRevision,
            },
          },
        });
        const result = yield* assessPricingQuantityBasis(exact);

        expect(result).toMatchObject({
          evidence: {
            effectiveAt,
            observedAt: laterObservedAt,
            ownerRevision: laterOwnerRevision,
            requestedOwnerRevision: 'catalog-quantity:17',
          },
          outcome: 'NO_CONVERSION_REQUIRED',
          priceQuantity: { amount: '10' },
          resultingPurchaseQuantity: { amount: '2' },
        });
        expect(result.attempt.catalog.evidence.assessedAt).toBe(effectiveAt);
      }),
  );

  it.effect('uses exact package and metre conversion revisions without recomputing pinned history', () =>
    Effect.gen(function* revisionQualifiedConversions() {
      const pinnedTen = yield* assessPricingQuantityBasis(
        decodeInput(
          conversion({
            fromPhysicalUnitRef: packageUnitRef,
            fromProductUnitRef: packageProductUnitRef,
            fromQuantity: '2',
            occurrenceId: 'purchase-demand:package-r10',
            packageRevision: 10,
            ratio: '10',
            toPhysicalUnitRef: pieceUnitRef,
            toProductUnitRef: pieceProductUnitRef,
            toQuantity: '20',
          }),
        ),
      );
      const currentEight = yield* assessPricingQuantityBasis(
        decodeInput(
          conversion({
            fromPhysicalUnitRef: packageUnitRef,
            fromProductUnitRef: packageProductUnitRef,
            fromQuantity: '2',
            occurrenceId: 'purchase-demand:package-r11',
            packageRevision: 11,
            ratio: '8',
            toPhysicalUnitRef: pieceUnitRef,
            toProductUnitRef: pieceProductUnitRef,
            toQuantity: '16',
          }),
        ),
      );
      const metres = yield* assessPricingQuantityBasis(
        decodeInput(
          conversion({
            fromPhysicalUnitRef: metreUnitRef,
            fromProductUnitRef: metreProductUnitRef,
            fromQuantity: '1.5',
            occurrenceId: 'purchase-demand:metres',
            ratio: '100',
            toPhysicalUnitRef: centimetreUnitRef,
            toProductUnitRef: centimetreProductUnitRef,
            toQuantity: '150',
          }),
        ),
      );

      expect(pinnedTen).toMatchObject({
        evidence: { steps: [{ toQuantity: '20' }] },
        outcome: 'COMPATIBLE_CONVERSION',
        priceQuantity: { amount: '10' },
        resultingPurchaseQuantity: { amount: '2' },
        tierQuantity: { amount: '10' },
      });
      expect(currentEight).toMatchObject({
        evidence: { steps: [{ toQuantity: '16' }] },
        outcome: 'COMPATIBLE_CONVERSION',
        priceQuantity: { amount: '10' },
      });
      expect(metres).toMatchObject({
        evidence: { steps: [{ toQuantity: '150' }] },
        outcome: 'COMPATIBLE_CONVERSION',
        priceQuantity: { amount: '10' },
      });
      expect(pinnedTen).toMatchObject({
        attempt: {
          price: { identityKey: { catalogSelection: { packageOption: { contentRevision: { revision: 10 } } } } },
        },
        evidence: { steps: [{ toQuantity: '20' }] },
        priceQuantity: { amount: '10' },
      });
    }),
  );

  it.effect('rejects valid conversion arithmetic that starts from a substituted purchase quantity', () =>
    Effect.gen(function* exactPurchaseConversionInput() {
      const exact = decodeInput(
        conversion({
          fromPhysicalUnitRef: packageUnitRef,
          fromProductUnitRef: packageProductUnitRef,
          fromQuantity: '2',
          occurrenceId: 'purchase-demand:substituted-conversion-input',
          packageRevision: 10,
          ratio: '10',
          toPhysicalUnitRef: pieceUnitRef,
          toProductUnitRef: pieceProductUnitRef,
          toQuantity: '20',
        }),
      );
      if (exact.ownerDecision.outcome !== 'COMPATIBLE_CONVERSION') {
        return;
      }
      const [step, ...remainingSteps] = exact.ownerDecision.steps;
      if (step === undefined) {
        return;
      }
      const result = yield* assessPricingQuantityBasis({
        ...exact,
        ownerDecision: {
          ...exact.ownerDecision,
          steps: [{ ...step, fromQuantity: '3', toQuantity: '30' }, ...remainingSteps],
        },
      });

      expect(result).toMatchObject({
        attempt: {
          catalog: { quantity: { resulting: '2' } },
          price: { identityKey: { unitBasis: { quantity: '10' } } },
        },
        outcome: 'UNVERIFIABLE',
        reason: 'CATALOG_PURCHASE_TO_PRICE_CONVERSION_DOES_NOT_USE_PRESERVED_QUANTITY',
      });
      expect(result).not.toHaveProperty('priceQuantity');
    }),
  );

  it.effect(
    'keeps 20 loose pieces and two package selections as three stable occurrences instead of pooling them',
    () =>
      Effect.gen(function* stableOccurrences() {
        const loose = yield* assessPricingQuantityBasis(decodeInput(noConversion('purchase-demand:loose')));
        const firstPackage = yield* assessPricingQuantityBasis(
          decodeInput(
            conversion({
              fromPhysicalUnitRef: packageUnitRef,
              fromProductUnitRef: packageProductUnitRef,
              fromQuantity: '1',
              occurrenceId: 'purchase-demand:package-A',
              packageRevision: 10,
              ratio: '10',
              toPhysicalUnitRef: pieceUnitRef,
              toProductUnitRef: pieceProductUnitRef,
              toQuantity: '10',
            }),
          ),
        );
        const secondPackage = yield* assessPricingQuantityBasis(
          decodeInput(
            conversion({
              fromPhysicalUnitRef: packageUnitRef,
              fromProductUnitRef: packageProductUnitRef,
              fromQuantity: '1',
              occurrenceId: 'purchase-demand:package-B',
              packageRevision: 10,
              ratio: '10',
              toPhysicalUnitRef: pieceUnitRef,
              toProductUnitRef: pieceProductUnitRef,
              toQuantity: '10',
            }),
          ),
        );

        expect([loose, firstPackage, secondPackage].map((result) => result.attempt.occurrenceId)).toEqual([
          'purchase-demand:loose',
          'purchase-demand:package-A',
          'purchase-demand:package-B',
        ]);
        expect([loose, firstPackage, secondPackage].map((result) => result.attempt.catalog.quantity.resulting)).toEqual(
          ['20', '1', '1'],
        );
        expect(loose.attempt.catalog.selection).not.toHaveProperty('packageOption');
        expect(firstPackage.attempt.catalog.selection).toHaveProperty('packageOption');
        expect(secondPackage.attempt.catalog.selection).toHaveProperty('packageOption');
        for (const result of [loose, firstPackage, secondPackage]) {
          expect(result).not.toHaveProperty('aggregatedQuantity');
        }
      }),
  );

  it.effect('fails typed on incompatible Units and never guesses, relabels, or returns price zero', () =>
    Effect.gen(function* incompatibleUnits() {
      const exact = decodeInput(noConversion('purchase-demand:incompatible'));
      if (exact.ownerDecision.outcome !== 'NO_CONVERSION_REQUIRED') {
        return;
      }
      const forged = {
        ...exact,
        attempt: {
          ...exact.attempt,
          price: {
            ...exact.attempt.price,
            identityKey: {
              ...exact.attempt.price.identityKey,
              unitBasis: { quantity: '10', unitRef: metreProductUnitRef },
            },
          },
          tier: {
            ...exact.attempt.tier,
            identityKey: {
              ...exact.attempt.tier?.identityKey,
              priceRef,
              quantityBasis: {
                catalogQuantityBasis: basis(selection(), metreProductUnitRef),
                priceUnitBasis: { quantity: '10', unitRef: metreProductUnitRef },
              },
              thresholdQuantity: '20',
            },
          },
        },
      };
      const result = yield* assessPricingQuantityBasis(decodeInput(forged));

      expect(result).toMatchObject({ outcome: 'INCOMPATIBLE' });
      expect(result).not.toHaveProperty('priceQuantity');
      expect(result).not.toHaveProperty('resultingUnitPrice');
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)).not.toContain('"amount":"0"');
    }),
  );

  it.effect('rejects hidden same-Unit quantity rewriting without conversion evidence', () =>
    Effect.gen(function* noHiddenNormalization() {
      const exact = decodeInput(noConversion('purchase-demand:no-hidden-normalization'));
      if (exact.ownerDecision.outcome !== 'NO_CONVERSION_REQUIRED') {
        return;
      }
      const forged = {
        ...exact,
        ownerDecision: {
          ...exact.ownerDecision,
          endpoints: {
            ...exact.ownerDecision.endpoints,
            purchase: { ...exact.ownerDecision.endpoints.purchase, quantity: '2' },
          },
        },
      };
      const result = yield* assessPricingQuantityBasis(decodeInput(forged));

      expect(result).toMatchObject({ outcome: 'UNVERIFIABLE' });
      expect(result).not.toHaveProperty('priceQuantity');
    }),
  );

  it.effect('preserves a typed unavailable assessment without fabricating owner evidence', () =>
    Effect.gen(function* unavailableOwnerRead() {
      const exact = noConversion('purchase-demand:unavailable-owner-read');
      const result = yield* assessPricingQuantityBasis(
        decodeInput({
          attempt: exact.attempt,
          ownerDecision: {
            effectiveAt,
            outcome: 'UNAVAILABLE',
            reason: 'Catalog currentness read is temporarily unavailable',
            retryable: true,
          },
        }),
      );

      expect(result).toMatchObject({
        outcome: 'UNAVAILABLE',
        reason: 'Catalog currentness read is temporarily unavailable',
        retryable: true,
      });
      expect(result).not.toHaveProperty('priceQuantity');
      expect(result).not.toHaveProperty('evidence');
    }),
  );

  it.effect('propagates invalid versus unverifiable owner states and keeps native EUR free of FX activation', () =>
    Effect.gen(function* typedFailuresAndCurrency() {
      const valid = decodeInput(noConversion('purchase-demand:eur', '20', 'EUR'));
      const eur = yield* assessPricingQuantityBasis(valid);
      expect(eur).toMatchObject({ outcome: 'NO_CONVERSION_REQUIRED', priceQuantity: { amount: '10' } });
      expect(eur.attempt.price.identityKey.currencyCode).toBe('EUR');
      expect(eur).not.toHaveProperty('exchangeRate');
      expect(eur).not.toHaveProperty('currencySupport');

      for (const ownerDecision of [
        { effectiveAt, outcome: 'INVALID' as const, reason: 'known invalid Unit' },
        { effectiveAt, outcome: 'UNVERIFIABLE' as const, reason: 'evidence cannot be verified' },
      ]) {
        const result = yield* assessPricingQuantityBasis(decodeInput({ attempt: valid.attempt, ownerDecision }));
        expect(result).toMatchObject({ outcome: ownerDecision.outcome, reason: ownerDecision.reason });
        expect(result).not.toHaveProperty('priceQuantity');
      }
    }),
  );
});
