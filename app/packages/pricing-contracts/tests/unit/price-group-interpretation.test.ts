import {
  PriceGroupInterpretationBasisSchema,
  PriceGroupInterpretationSchema,
} from '../../src/domain/price-group-interpretation.ts';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const tenantId = '10000000-0000-4000-8000-000000000001';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const basis = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: '30000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '40000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
  commercialScope: {
    channelId: 'B2B',
    marketId: 'CZ',
    sellingLegalEntityId: '50000000-0000-4000-8000-000000000001',
  },
  currencyCode: 'CZK',
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '60000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
} as const;

describe('Price Group interpretation contract', () => {
  it('keeps the exact monetary basis while separating Group price selection from discount audience', () => {
    expect(Schema.is(PriceGroupInterpretationBasisSchema)(basis)).toBe(true);
    expect(
      Schema.is(PriceGroupInterpretationSchema)({
        _tag: 'ASSIGNED',
        assignmentResolution: {
          _tag: 'ASSIGNED',
          assignmentRef: {
            moduleId: 'commerce.customer-context',
            resourceId: '80000000-0000-4000-8000-000000000001',
            resourceType: 'commerce.customer-context.customer-price-group-assignment',
            tenantId,
          },
          assignmentRevision: 4,
          compatibility: {
            catalogRevision: 7,
            definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
            definitionRevisionId: '90000000-0000-4000-8000-000000000001',
            definitionRevisionNumber: 3,
            meaningFingerprint: 'a'.repeat(64),
            priceGroupRef,
            requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
            trustedOperationAt: '2026-09-27T10:00:00.000Z',
            verifiedAt: '2026-09-27T10:00:01.000Z',
          },
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: null,
          priceGroupRef,
        },
        basis,
        compatibilityEvidence: {
          catalogRevision: 7,
          definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
          definitionRevisionId: '90000000-0000-4000-8000-000000000001',
          definitionRevisionNumber: 3,
          meaningFingerprint: 'a'.repeat(64),
          priceGroupRef,
          requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
          trustedOperationAt: '2026-09-27T10:00:00.000Z',
          verifiedAt: '2026-09-27T10:00:02.000Z',
        },
        discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
        priceGroupRef,
        priceSelector: { kind: 'PRICE_GROUP', priceGroupRef },
      }),
    ).toBe(true);
  });

  it('rejects a Unit from another Tenant instead of weakening the exact basis', () => {
    expect(
      Schema.is(PriceGroupInterpretationBasisSchema)({
        ...basis,
        unitBasis: {
          ...basis.unitBasis,
          unitRef: { ...basis.unitBasis.unitRef, tenantId: '10000000-0000-4000-8000-000000000099' },
        },
      }),
    ).toBe(false);
  });
});
