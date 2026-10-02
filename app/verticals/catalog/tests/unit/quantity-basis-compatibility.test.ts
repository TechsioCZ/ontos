import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { QuantityBasisCompatibilityResponseSchema } from '../../shared/apis/quantity-basis-compatibility.ts';
import type { QuantityBasisCompatibilityResponse } from '../../shared/apis/quantity-basis-compatibility.ts';
import { CatalogQuantityHandoffReadySchema } from '../../shared/domain/catalog-quantity-handoff.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  assessQuantityBasisCompatibility,
  quantityBasisUnavailable,
} from '../../src/services/quantity-basis-compatibility.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const productUnitRef = ref('commerce.catalog.product-unit', '44444444-4444-4444-8444-444444444444');
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const quantityBasis = {
  targetDivisibilityRevision: 3,
  targetRef: variantRef,
  unitRef: productUnitRef,
  unitRuleRevision: 7,
};
const handoff = Schema.decodeUnknownSync(CatalogQuantityHandoffReadySchema)({
  completeness: {
    observedAt: '2026-09-27T12:00:00.000Z',
    ownerRevision: 'commerce.catalog.quantity:owner-1',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'commerce.catalog.quantity:test' },
  },
  divisible: false,
  equivalentSelectionKey: 'commerce.catalog.selection:exact-1',
  evidence: {
    assessedAt: '2026-09-27T12:00:00.000Z',
    basis: [
      { role: 'PRODUCT', source: { resourceRef: productRef, revision: 2 } },
      { role: 'VARIANT', source: { resourceRef: variantRef, revision: 4 } },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: productRef, revision: 2 },
      },
    ],
    membership: {
      attestationId: 'membership-1',
      observedAt: '2026-09-27T12:00:00.000Z',
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: variantRef, revision: 4 },
    },
    purpose: 'PRICING',
    selection,
    status: 'VALID',
  },
  hierarchyRevision: 'commerce.catalog.hierarchy:hierarchy-1',
  ownerRevision: 'commerce.catalog.quantity:owner-1',
  quantity: {
    changed: false,
    notice: null,
    requested: '2',
    resulting: '2',
    rounding: 'UP',
    status: 'VALID',
    step: '1',
    targetId: variantRef.resourceId,
    tenantId,
    unitId: productUnitRef.resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis,
  selection,
  status: 'READY',
  unitRef: productUnitRef,
});
const request = () => ({
  effectiveAt: handoff.evidence.assessedAt,
  handoff,
  price: { quantity: '1', quantityBasis },
  tier: { quantity: '2', quantityBasis },
});
type NoConversionDecision = Extract<QuantityBasisCompatibilityResponse, { outcome: 'NO_CONVERSION_REQUIRED' }>;
const physicalMapping = (
  result: NoConversionDecision,
  role: 'PRICE' | 'PURCHASE',
  physicalUnitRevision: { readonly resourceRef: ReturnType<typeof ref>; readonly revision: number },
) => ({
  effectiveAt: result.effectiveAt,
  observedAt: result.observedAt,
  ownerModuleId: 'commerce.catalog' as const,
  ownerRevision: result.ownerRevision,
  physicalUnitRevision,
  productUnitBasis: result.endpoints[role === 'PRICE' ? 'price' : 'purchase'].quantityBasis,
  role,
  source: 'CATALOG_OWNER_CURRENT_READ' as const,
});

describe('Catalog Quantity basis compatibility', () => {
  it('confirms only one exact Product Unit rule basis without synthesizing conversion evidence', () => {
    const result = assessQuantityBasisCompatibility(request(), handoff);
    expect(result.outcome).toBe('NO_CONVERSION_REQUIRED');
    expect(Schema.is(QuantityBasisCompatibilityResponseSchema)(result)).toBe(true);
    if (result.outcome !== 'NO_CONVERSION_REQUIRED') {
      return;
    }
    expect(result.endpoints.requested.quantity).toBe('2');
    expect(result.endpoints.price.quantity).toBe('1');
    expect(result.endpoints.purchase.quantityBasis.unitRuleRevision).toBe(7);
    expect(result.generation).toBe(handoff.ownerRevision);
    expect(result.currentnessEvidence).toMatchObject({
      effectiveAt: handoff.evidence.assessedAt,
      generation: handoff.ownerRevision,
      observedAt: handoff.evidence.assessedAt,
      predicateRef: handoff.completeness.scope.predicateRef,
      revalidatedAt: handoff.evidence.assessedAt,
      verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
    });
    expect(result.verificationReceipt).toMatchObject({
      generation: handoff.ownerRevision,
      issuedAt: handoff.evidence.assessedAt,
      ownerRevision: handoff.ownerRevision,
      predicate: {
        effectiveAt: handoff.evidence.assessedAt,
        price: request().price,
        requestedQuantity: handoff.quantity.requested,
        requestedQuantityBasis: handoff.quantityBasis,
        requestedUnitRef: handoff.unitRef,
        selection,
        tier: request().tier,
      },
      predicateRef: handoff.completeness.scope.predicateRef,
    });
    expect('steps' in result).toBe(false);
  });

  it('binds a later Current observation to the original effective instant without latency failure', () => {
    const current = Schema.decodeUnknownSync(CatalogQuantityHandoffReadySchema)({
      ...handoff,
      completeness: {
        ...handoff.completeness,
        observedAt: '2026-09-27T12:00:01.000Z',
        ownerRevision: 'commerce.catalog.quantity:owner-2',
      },
      evidence: {
        ...handoff.evidence,
        assessedAt: '2026-09-27T12:00:01.000Z',
        membership: {
          ...handoff.evidence.membership,
          attestationId: 'membership-2',
          observedAt: '2026-09-27T12:00:01.000Z',
        },
      },
      ownerRevision: 'commerce.catalog.quantity:owner-2',
    });
    const result = assessQuantityBasisCompatibility(request(), current);
    expect(result).toMatchObject({
      effectiveAt: '2026-09-27T12:00:00.000Z',
      generation: 'commerce.catalog.quantity:owner-2',
      observedAt: '2026-09-27T12:00:01.000Z',
      outcome: 'NO_CONVERSION_REQUIRED',
      ownerRevision: 'commerce.catalog.quantity:owner-2',
      requestedOwnerRevision: 'commerce.catalog.quantity:owner-1',
      verificationReceipt: {
        generation: 'commerce.catalog.quantity:owner-2',
        predicateRef: handoff.completeness.scope.predicateRef,
      },
    });
    expect(Schema.is(QuantityBasisCompatibilityResponseSchema)(result)).toBe(true);
  });

  it('fails unverifiable when a Price or Tier requires an owner mapping Catalog does not store', () => {
    const otherUnit = ref('commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555555');
    const result = assessQuantityBasisCompatibility(
      { ...request(), price: { quantity: '1', quantityBasis: { ...quantityBasis, unitRef: otherUnit } } },
      handoff,
    );
    expect(result.outcome).toBe('UNVERIFIABLE');
    expect(result).toMatchObject({ reason: expect.stringContaining('no authoritative stored conversion') });
  });

  it('rejects forged no-conversion evidence whose endpoints do not share the exact Product Unit rule', () => {
    const result = assessQuantityBasisCompatibility(request(), handoff);
    if (result.outcome !== 'NO_CONVERSION_REQUIRED') {
      throw new Error('Fixture must resolve without conversion');
    }
    expect(
      Schema.is(QuantityBasisCompatibilityResponseSchema)({
        ...result,
        endpoints: {
          ...result.endpoints,
          price: {
            ...result.endpoints.price,
            quantityBasis: { ...result.endpoints.price.quantityBasis, unitRuleRevision: 8 },
          },
        },
      }),
    ).toBe(false);
  });

  it('rejects unrelated same-Tenant physical Unit conversion evidence without exact endpoint mappings', () => {
    const result = assessQuantityBasisCompatibility(request(), handoff);
    if (result.outcome !== 'NO_CONVERSION_REQUIRED') {
      throw new Error('Fixture must resolve without conversion');
    }
    const physicalFrom = {
      resourceRef: ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666666'),
      revision: 1,
    };
    const physicalTo = {
      resourceRef: ref('commerce.catalog.unit', '77777777-7777-4777-8777-777777777777'),
      revision: 1,
    };
    const unrelatedPhysicalTo = {
      resourceRef: ref('commerce.catalog.unit', '88888888-8888-4888-8888-888888888888'),
      revision: 1,
    };
    const compatible = {
      ...result,
      mappings: [
        physicalMapping(result, 'PURCHASE', physicalFrom),
        physicalMapping(result, 'PRICE', unrelatedPhysicalTo),
      ],
      outcome: 'COMPATIBLE_CONVERSION',
      steps: [
        {
          conversion: {
            denominator: '2',
            evidenceId: '99999999-9999-4999-8999-999999999999',
            from: physicalFrom,
            numerator: '1',
            observedAt: result.observedAt,
            ownerModuleId: 'commerce.catalog',
            source: 'CATALOG_OWNER_CURRENT_READ',
            to: physicalTo,
          },
          from: 'PURCHASE',
          fromQuantity: '2',
          to: 'PRICE',
          toQuantity: '1',
        },
      ],
    } as const;
    expect(Schema.is(QuantityBasisCompatibilityResponseSchema)(compatible)).toBe(false);
    expect(
      Schema.is(QuantityBasisCompatibilityResponseSchema)({
        ...compatible,
        mappings: [physicalMapping(result, 'PURCHASE', physicalFrom), physicalMapping(result, 'PRICE', physicalTo)],
      }),
    ).toBe(true);
  });

  it('rejects a valid unrelated conversion amount that does not start at the preserved purchase quantity', () => {
    const result = assessQuantityBasisCompatibility(request(), handoff);
    if (result.outcome !== 'NO_CONVERSION_REQUIRED') {
      throw new Error('Fixture must resolve without conversion');
    }
    const physicalFrom = {
      resourceRef: ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666666'),
      revision: 1,
    };
    const physicalTo = {
      resourceRef: ref('commerce.catalog.unit', '77777777-7777-4777-8777-777777777777'),
      revision: 1,
    };
    expect(
      Schema.is(QuantityBasisCompatibilityResponseSchema)({
        ...result,
        mappings: [physicalMapping(result, 'PURCHASE', physicalFrom), physicalMapping(result, 'PRICE', physicalTo)],
        outcome: 'COMPATIBLE_CONVERSION',
        steps: [
          {
            conversion: {
              denominator: '1',
              evidenceId: '99999999-9999-4999-8999-999999999999',
              from: physicalFrom,
              numerator: '10',
              observedAt: result.observedAt,
              ownerModuleId: 'commerce.catalog',
              source: 'CATALOG_OWNER_CURRENT_READ',
              to: physicalTo,
            },
            from: 'PURCHASE',
            fromQuantity: '3',
            to: 'PRICE',
            toQuantity: '30',
          },
        ],
      }),
    ).toBe(false);
  });

  it('distinguishes changed Current meaning from an owner outage', () => {
    expect(
      assessQuantityBasisCompatibility(request(), {
        ...handoff,
        quantityBasis: { ...handoff.quantityBasis, unitRuleRevision: 8 },
      }).outcome,
    ).toBe('UNVERIFIABLE');
    const unavailable = quantityBasisUnavailable(request());
    expect(unavailable).toEqual({
      effectiveAt: handoff.evidence.assessedAt,
      outcome: 'UNAVAILABLE',
      reason: 'Catalog Quantity basis currentness is temporarily unavailable',
      retryable: true,
    });
    expect(unavailable).not.toHaveProperty('observedAt');
    expect(unavailable).not.toHaveProperty('ownerRevision');
    expect(unavailable).not.toHaveProperty('source');
    expect(Schema.is(QuantityBasisCompatibilityResponseSchema)(unavailable)).toBe(true);
  });

  it('keeps unobserved invalid and unverifiable preparation failures free of caller-reissued owner evidence', () => {
    for (const current of [
      { reason: 'Catalog selection is invalid', status: 'INVALID' as const },
      { reason: 'Catalog selection cannot be verified', status: 'UNVERIFIABLE' as const },
    ]) {
      const result = assessQuantityBasisCompatibility(request(), current);
      expect(result).toEqual({
        effectiveAt: handoff.evidence.assessedAt,
        outcome: current.status,
        reason: current.reason,
      });
      expect(result).not.toHaveProperty('generation');
      expect(result).not.toHaveProperty('observedAt');
      expect(Schema.is(QuantityBasisCompatibilityResponseSchema)(result)).toBe(true);
    }
  });

  it('rejects a receipt that substitutes the exact requested Quantity basis', () => {
    const result = assessQuantityBasisCompatibility(request(), handoff);
    if (result.outcome !== 'NO_CONVERSION_REQUIRED') {
      throw new Error('Fixture must resolve without conversion');
    }
    expect(
      Schema.is(QuantityBasisCompatibilityResponseSchema)({
        ...result,
        verificationReceipt: {
          ...result.verificationReceipt,
          predicate: {
            ...result.verificationReceipt.predicate,
            requestedQuantityBasis: {
              ...result.verificationReceipt.predicate.requestedQuantityBasis,
              unitRuleRevision: 999,
            },
          },
        },
      }),
    ).toBe(false);
  });
});
