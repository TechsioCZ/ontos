import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingCatalogQuantityBasisDecisionSchema,
  PricingQuantityBasisAssessmentInputSchema,
  PricingQuantityBasisAssessmentSchema,
} from '../../src/domain/quantity-unit-package-basis.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const variantRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant');
const packageRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.package-definition');
const productUnitRef = catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.product-unit');
const pieceProductUnitRef = catalogRef('ffffffff-ffff-4fff-8fff-ffffffffffff', 'commerce.catalog.product-unit');
const pieceUnitRef = catalogRef('66666666-6666-4666-8666-666666666666', 'commerce.catalog.unit');
const packageUnitRef = catalogRef('77777777-7777-4777-8777-777777777777', 'commerce.catalog.unit');
const selection = {
  packageOption: {
    contentRevision: { resourceRef: packageRef, revision: 5 },
    optionRef: packageRef,
  },
  productRef,
  setComposition: {
    resourceRef: catalogRef('88888888-8888-4888-8888-888888888888', 'commerce.catalog.set-composition'),
    revision: 4,
  },
  variantRef,
};
const observedAt = '2026-09-27T10:00:00.000Z';
const currentObservedAt = '2026-09-27T10:00:01.000Z';
const leanFailureOutcomeNoun = {
  INVALID: 'invalidity',
  UNAVAILABLE: 'unavailability',
  UNVERIFIABLE: 'unverifiability',
} as const;
const quantityBasis = {
  targetDivisibilityRevision: 3,
  targetRef: packageRef,
  unitRef: productUnitRef,
  unitRuleRevision: 7,
};
const pieceQuantityBasis = { ...quantityBasis, unitRef: pieceProductUnitRef, unitRuleRevision: 11 };
const completeness = {
  observedAt,
  ownerRevision: 'catalog-quantity-basis:17',
  scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog:quantity-basis:package:17' },
};
const catalog = {
  completeness,
  divisible: false,
  equivalentSelectionKey: 'catalog-selection:package:17',
  evidence: {
    assessedAt: observedAt,
    basis: [
      { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
      { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 2 } },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
        role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
        source: { resourceRef: productRef, revision: 1 },
      },
      { role: 'PACKAGE_CONTENT' as const, source: selection.packageOption.contentRevision },
      { role: 'SET_COMPOSITION' as const, source: selection.setComposition },
    ],
    membership: {
      attestationId: '99999999-9999-4999-8999-999999999999',
      observedAt,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      variant: { resourceRef: variantRef, revision: 2 },
    },
    purpose: 'PRICING',
    selection,
    status: 'VALID' as const,
  },
  hierarchyRevision: 'catalog-hierarchy:9',
  ownerRevision: 'catalog-quantity:17',
  packageRevision: {
    amount: '10',
    form: { productRef, variantRef },
    reference: selection.packageOption.contentRevision,
    setComposition: selection.setComposition,
    unitRef: pieceUnitRef,
  },
  quantity: {
    changed: false,
    notice: null,
    requested: '2',
    resulting: '2',
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
    step: '1',
    targetId: packageRef.resourceId,
    tenantId,
    unitId: productUnitRef.resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis,
  selection,
  status: 'READY' as const,
  unitRef: productUnitRef,
};
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const price = {
  identityKey: {
    catalogSelection: selection,
    commercialScope: {
      channelId: 'B2C',
      marketId: 'cz-launch',
      sellingLegalEntityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
    currencyCode: 'CZK' as const,
    priceGroupSelector: { kind: 'NO_GROUP' as const },
    unitBasis: { quantity: '1', unitRef: productUnitRef },
  },
  priceRef,
  revision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount: '100', currencyCode: 'CZK' as const },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 1,
    revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  },
};
const tier = {
  identityKey: {
    priceRef,
    quantityBasis: { catalogQuantityBasis: quantityBasis, priceUnitBasis: price.identityKey.unitBasis },
    thresholdQuantity: '10',
  },
  revision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryBoundary: 'PRE_TAX' as const,
    resultingUnitPrice: { amount: '90', currencyCode: 'CZK' as const },
    revision: 1,
    revisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  },
};
const endpoint = (quantity: string, basis = quantityBasis) => ({
  quantity,
  quantityBasis: basis,
});
const evidenceBase = {
  completeness: {
    ...completeness,
    observedAt: currentObservedAt,
    ownerRevision: 'catalog-quantity:18',
  },
  currentness: { observedAt: currentObservedAt, ownerRevision: 'catalog-quantity:18', status: 'CURRENT' as const },
  currentnessEvidence: {
    effectiveAt: observedAt,
    generation: 'catalog-quantity:18',
    observedAt: currentObservedAt,
    predicateRef: completeness.scope.predicateRef,
    revalidatedAt: currentObservedAt,
    verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED' as const,
  },
  effectiveAt: observedAt,
  equivalentSelectionKey: catalog.equivalentSelectionKey,
  generation: 'catalog-quantity:18',
  hierarchyRevision: catalog.hierarchyRevision,
  observedAt: currentObservedAt,
  ownerModuleId: 'commerce.catalog' as const,
  ownerRevision: 'catalog-quantity:18',
  requestedOwnerRevision: catalog.ownerRevision,
  requestedQuantity: catalog.quantity.requested,
  requestedQuantityBasis: quantityBasis,
  requestedUnitRef: productUnitRef,
  selection,
  source: 'CATALOG_OWNER_CURRENT_READ' as const,
  verificationReceipt: {
    generation: 'catalog-quantity:18',
    issuedAt: currentObservedAt,
    ownerModuleId: 'commerce.catalog' as const,
    ownerRevision: 'catalog-quantity:18',
    predicate: {
      effectiveAt: observedAt,
      price: { quantity: '1', quantityBasis },
      requestedQuantity: catalog.quantity.requested,
      requestedQuantityBasis: quantityBasis,
      requestedUnitRef: productUnitRef,
      selection,
      tier: { quantity: '1', quantityBasis },
    },
    predicateRef: completeness.scope.predicateRef,
    verificationRef: 'catalog-quantity-basis:verification:18',
  },
};
const noConversion = {
  ...evidenceBase,
  endpoints: {
    price: endpoint('1'),
    purchase: endpoint('2'),
    requested: endpoint('2'),
    tier: endpoint('1'),
  },
  outcome: 'NO_CONVERSION_REQUIRED' as const,
};
const conversion = {
  ...evidenceBase,
  endpoints: {
    price: endpoint('1', pieceQuantityBasis),
    purchase: endpoint('2'),
    requested: endpoint('2'),
    tier: endpoint('1', pieceQuantityBasis),
  },
  mappings: [
    {
      effectiveAt: observedAt,
      observedAt: currentObservedAt,
      ownerModuleId: 'commerce.catalog' as const,
      ownerRevision: 'catalog-quantity:18',
      physicalUnitRevision: { resourceRef: packageUnitRef, revision: 3 },
      productUnitBasis: quantityBasis,
      role: 'PURCHASE' as const,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
    },
    {
      effectiveAt: observedAt,
      observedAt: currentObservedAt,
      ownerModuleId: 'commerce.catalog' as const,
      ownerRevision: 'catalog-quantity:18',
      physicalUnitRevision: { resourceRef: pieceUnitRef, revision: 8 },
      productUnitBasis: pieceQuantityBasis,
      role: 'PRICE' as const,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
    },
  ],
  outcome: 'COMPATIBLE_CONVERSION' as const,
  steps: [
    {
      conversion: {
        denominator: '1',
        evidenceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        from: { resourceRef: packageUnitRef, revision: 3 },
        numerator: '10',
        observedAt: currentObservedAt,
        ownerModuleId: 'commerce.catalog' as const,
        source: 'CATALOG_OWNER_CURRENT_READ' as const,
        to: { resourceRef: pieceUnitRef, revision: 8 },
      },
      from: 'PURCHASE' as const,
      fromQuantity: '2',
      to: 'PRICE' as const,
      toQuantity: '20',
    },
  ],
};
const attempt = { catalog, effectiveAt: observedAt, occurrenceId: 'purchase-demand-occurrence:17', price, tier };

describe('Pricing Quantity/Unit/package-basis contract', () => {
  it('accepts exact no-conversion evidence without rewriting the stable line or pinned selection', () => {
    const decodeInput = Schema.decodeUnknownSync(PricingQuantityBasisAssessmentInputSchema, {
      onExcessProperty: 'error',
    });
    const decoded = decodeInput({ attempt, ownerDecision: noConversion });

    expect(decoded.attempt.occurrenceId).toBe('purchase-demand-occurrence:17');
    expect(decoded.attempt.catalog.quantity).toMatchObject({ requested: '2', resulting: '2' });
    expect(decoded.attempt.catalog.selection.packageOption?.contentRevision.revision).toBe(5);
    expect(decoded.attempt.catalog.selection.setComposition?.revision).toBe(4);
    expect(decoded.ownerDecision.outcome).toBe('NO_CONVERSION_REQUIRED');
    if (
      decoded.ownerDecision.outcome === 'INVALID' ||
      decoded.ownerDecision.outcome === 'UNAVAILABLE' ||
      (decoded.ownerDecision.outcome === 'UNVERIFIABLE' && !('observedAt' in decoded.ownerDecision))
    ) {
      throw new Error('Expected owner Quantity-basis evidence');
    }
    expect(decoded.ownerDecision.observedAt).toBe(currentObservedAt);
    expect(decoded.attempt.catalog.evidence.assessedAt).toBe(observedAt);
    expect(() =>
      decodeInput({
        attempt: { ...attempt, effectiveAt: currentObservedAt },
        ownerDecision: { ...noConversion, effectiveAt: currentObservedAt },
      }),
    ).toThrow();
  });

  it('requires explicit revision-qualified exact arithmetic for compatible conversion evidence', () => {
    const decode = Schema.decodeUnknownSync(PricingCatalogQuantityBasisDecisionSchema, {
      onExcessProperty: 'error',
    });
    expect(decode(conversion).outcome).toBe('COMPATIBLE_CONVERSION');
    expect(() =>
      decode({
        ...conversion,
        steps: [{ ...conversion.steps[0], toQuantity: '19' }],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...conversion,
        steps: [{ ...conversion.steps[0], fromQuantity: '3', toQuantity: '30' }],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...conversion,
        mappings: conversion.mappings.map((mapping) =>
          mapping.role === 'PRICE'
            ? { ...mapping, physicalUnitRevision: { resourceRef: packageUnitRef, revision: 3 } }
            : mapping,
        ),
      }),
    ).toThrow();
    expect(() => decode({ ...conversion, steps: [] })).toThrow();
  });

  it('keeps proof-bearing incompatibility and unverifiability distinct from lean invalidity and unavailability', () => {
    const decode = Schema.decodeUnknownSync(PricingCatalogQuantityBasisDecisionSchema, {
      onExcessProperty: 'error',
    });
    const evidencedFailures = [
      { outcome: 'INCOMPATIBLE', reason: 'PACKAGE_AND_PIECE_BASES_NOT_COMPATIBLE' },
      { outcome: 'UNVERIFIABLE', reason: 'OWNER_EVIDENCE_INCOMPLETE' },
    ] as const;
    const leanFailures = [
      {
        effectiveAt: observedAt,
        outcome: 'INVALID',
        reason: 'CATALOG_QUANTITY_INVALID',
      },
      {
        effectiveAt: observedAt,
        outcome: 'UNAVAILABLE',
        reason: 'CATALOG_OWNER_UNAVAILABLE',
        retryable: true,
      },
    ] as const;

    expect(evidencedFailures.map((failure) => decode({ ...evidenceBase, ...failure }).outcome)).toEqual([
      'INCOMPATIBLE',
      'UNVERIFIABLE',
    ]);
    for (const failure of leanFailures) {
      const decoded = decode(failure);
      expect(decoded).toEqual(failure);
      expect(decoded).not.toHaveProperty('currentness');
      expect(decoded).not.toHaveProperty('completeness');
      expect(() => decode({ ...evidenceBase, ...failure })).toThrow();
    }
    for (const failure of evidencedFailures) {
      expect('result' in decode({ ...evidenceBase, ...failure })).toBe(false);
    }
  });

  it('accepts caller-bound lean failures without requiring fabricated owner evidence', () => {
    const decodeInput = Schema.decodeUnknownSync(PricingQuantityBasisAssessmentInputSchema, {
      onExcessProperty: 'error',
    });
    const ownerDecisions = [
      {
        effectiveAt: observedAt,
        outcome: 'INVALID' as const,
        reason: 'Catalog rejected the requested Quantity basis',
      },
      {
        effectiveAt: observedAt,
        outcome: 'UNAVAILABLE' as const,
        reason: 'Catalog owner read is temporarily unavailable',
        retryable: true,
      },
      {
        effectiveAt: observedAt,
        outcome: 'UNVERIFIABLE' as const,
        reason: 'Catalog could not verify the prepared Quantity basis',
      },
    ];

    for (const ownerDecision of ownerDecisions) {
      expect(decodeInput({ attempt, ownerDecision }).ownerDecision).toEqual(ownerDecision);
      expect(() =>
        decodeInput({
          attempt,
          ownerDecision: { ...ownerDecision, effectiveAt: currentObservedAt },
        }),
      ).toThrow(
        `Quantity-basis ${leanFailureOutcomeNoun[ownerDecision.outcome]} must bind the exact requested effective time`,
      );
    }
  });

  it('closes the assessment result over exact success or typed failure without Storefront, FX, or money fields', () => {
    const decode = Schema.decodeUnknownSync(PricingQuantityBasisAssessmentSchema, {
      onExcessProperty: 'error',
    });
    const success = decode({
      attempt,
      evidence: noConversion,
      occurrenceId: attempt.occurrenceId,
      outcome: 'NO_CONVERSION_REQUIRED',
      priceQuantity: { amount: '1', unitRef: productUnitRef },
      requestedQuantity: { amount: '2', unitRef: productUnitRef },
      resultingPurchaseQuantity: { amount: '2', unitRef: productUnitRef },
      selection,
      tierQuantity: { amount: '1', unitRef: productUnitRef },
    });
    expect(success.outcome).toBe('NO_CONVERSION_REQUIRED');
    if (success.outcome !== 'NO_CONVERSION_REQUIRED') {
      throw new Error('Expected a no-conversion Quantity-basis assessment');
    }
    expect(success.occurrenceId).toBe(attempt.occurrenceId);
    expect(success.resultingPurchaseQuantity.amount).toBe('2');
    expect(success.priceQuantity.amount).toBe('1');
    expect(success.tierQuantity?.amount).toBe('1');
    expect(success.attempt.tier?.identityKey.thresholdQuantity).toBe('10');
    expect(Object.keys(success.evidence)).not.toEqual(
      expect.arrayContaining(['storefrontId', 'exchangeRate', 'currencyCode', 'money']),
    );
    expect(() => decode({ ...success, occurrenceId: 'rewritten-line' })).toThrow();
    expect(() =>
      decode({
        attempt,
        outcome: 'INCOMPATIBLE',
        reason: 'PACKAGE_AND_PIECE_BASES_NOT_COMPATIBLE',
        result: { amount: '0' },
      }),
    ).toThrow();
  });
});
