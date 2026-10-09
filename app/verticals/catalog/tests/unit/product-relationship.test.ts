import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  ProductRelationshipSchema,
  productRelationshipHasDuplicate,
  productRelationshipIsCurrent,
} from '../../shared/domain/product-relationship.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const source = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const target = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const assertion = {
  effectivePeriod: {},
  evidenceRefs: ['manufacturer-document'],
  reason: 'Documented use for this target',
  source,
  target,
  type: 'ACCESSORY_FOR',
} as const;
const decode = Schema.decodeUnknownSync(ProductRelationshipSchema);

describe('Catalog Product relationship domain', () => {
  it('keeps supported meanings and endpoint direction explicit', () => {
    const accessory = decode(assertion);
    expect(accessory.source).toEqual(source);
    expect(accessory.target).toEqual(target);
    expect(decode({ ...assertion, type: 'RELATED_PRODUCT' }).type).toBe('RELATED_PRODUCT');
    expect(decode({ ...assertion, type: 'SUCCESSOR' }).type).toBe('SUCCESSOR');
    expect(() => decode({ ...assertion, type: 'OTHER' })).toThrow();
    expect(() => decode({ ...assertion, source: target, target: source })).not.toThrow();
  });

  it('rejects cross-Tenant and self references and requires evidence', () => {
    expect(() =>
      decode({ ...assertion, target: { ...target, tenantId: '99999999-9999-4999-8999-999999999999' } }),
    ).toThrow();
    expect(() => decode({ ...assertion, target: source })).toThrow();
    expect(() => decode({ ...assertion, evidenceRefs: [] })).toThrow();
  });

  it('uses known inclusive-start/exclusive-end bounds without inventing an unknown start', () => {
    const from = '2026-09-01T00:00:00.000Z';
    const to = '2026-10-01T00:00:00.000Z';
    const relationship = decode({ ...assertion, effectivePeriod: { effectiveFrom: from, effectiveTo: to } });
    expect(productRelationshipIsCurrent(relationship, from)).toBe(true);
    expect(productRelationshipIsCurrent(relationship, to)).toBe(false);
    expect(productRelationshipIsCurrent(relationship, '2026-08-31T23:59:59.000Z')).toBe(false);
    expect(decode(assertion).effectivePeriod.effectiveFrom).toBeUndefined();
    expect(() => decode({ ...assertion, effectivePeriod: { effectiveFrom: to, effectiveTo: from } })).toThrow();
  });

  it('rejects an exact duplicate but allows distinct types and directed assertions', () => {
    const existing = decode(assertion);
    expect(productRelationshipHasDuplicate([existing], decode(assertion))).toBe(true);
    expect(productRelationshipHasDuplicate([existing], decode({ ...assertion, type: 'RELATED_PRODUCT' }))).toBe(false);
    expect(productRelationshipHasDuplicate([existing], decode({ ...assertion, source: target, target: source }))).toBe(
      false,
    );
  });
});
