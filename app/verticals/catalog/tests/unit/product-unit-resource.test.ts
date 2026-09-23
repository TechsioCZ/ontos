import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ProductUnitMeaningSchema,
  ProductUnitRefSchema,
  ProductUnitRuleRevisionSchema,
  ProductUnitTargetDivisibilitySchema,
} from '../../shared/resources/product-unit.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const unitId = '22222222-2222-4222-8222-222222222222';
const unit = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;

describe('Catalog Product Unit resource contract', () => {
  it('uses a stable tenant-qualified ResourceRef distinct from display meaning', () => {
    const meaning = Schema.decodeUnknownSync(ProductUnitMeaningSchema)({ code: 'M', label: 'metre', ref: unit });
    expect(meaning.ref).toEqual(Schema.decodeUnknownSync(ProductUnitRefSchema)(unit));
    expect(
      Schema.decodeUnknownSync(ProductUnitMeaningSchema)({ code: 'M', label: 'metre (renamed)', ref: unit }).ref,
    ).toEqual(meaning.ref);
    expect(() => Schema.decodeUnknownSync(ProductUnitRefSchema)({ ...unit, tenantId: '' })).toThrow();
    expect(() => Schema.decodeUnknownSync(ProductUnitRefSchema)({ ...unit, resourceId: 'metre' })).toThrow();
  });

  it('keeps step and rounding explicit and versioned without any conversion assertion', () => {
    const revision = Schema.decodeUnknownSync(ProductUnitRuleRevisionSchema)({
      revision: 7,
      rounding: 'UP',
      step: '0.01',
      unit,
    });
    expect(revision.unit).toEqual(unit);
    expect(revision).not.toHaveProperty('conversionFactor');
    for (const step of ['0', '0.00', '-1', 'NaN', '1e2']) {
      expect(() => Schema.decodeUnknownSync(ProductUnitRuleRevisionSchema)({ ...revision, step })).toThrow();
    }
    expect(() => Schema.decodeUnknownSync(ProductUnitRuleRevisionSchema)({ ...revision, revision: 0 })).toThrow();
    expect(() => Schema.decodeUnknownSync(ProductUnitRuleRevisionSchema)({ ...revision, rounding: null })).toThrow();
  });

  it('records target-specific divisibility separately from the tenant-wide Unit rule', () => {
    const fact = Schema.decodeUnknownSync(ProductUnitTargetDivisibilitySchema)({
      divisible: false,
      revision: 3,
      targetId: '33333333-3333-4333-8333-333333333333',
      targetType: 'commerce.catalog.variant',
      tenantId,
      unit,
    });
    expect(fact.divisible).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(ProductUnitTargetDivisibilitySchema)({ ...fact, targetType: 'other' }),
    ).toThrow();
  });
});
