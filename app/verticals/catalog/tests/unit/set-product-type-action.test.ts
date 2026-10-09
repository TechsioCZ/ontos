import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { SetProductTypePayloadSchema, setProductTypeAction } from '../../src/actions/set-product-type.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const nextProductTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-type',
  tenantId,
} as const;

describe('Set Product Type Action contract', () => {
  it('requires a preview basis and Product revision for assignment or removal', () => {
    const decode = Schema.decodeUnknownSync(SetProductTypePayloadSchema);
    expect(
      decode({
        expectedProductRevision: 1,
        impactBasis: 'sha256:population-1',
        nextProductTypeRef,
        productRef,
        reason: 'Different data requirements',
      }).nextProductTypeRef,
    ).toEqual(nextProductTypeRef);
    expect(
      decode({
        expectedProductRevision: 1,
        impactBasis: 'sha256:population-2',
        productRef,
        reason: 'Confirmed no structured need',
      }).nextProductTypeRef,
    ).toBeUndefined();
    expect(() => decode({ nextProductTypeRef, productRef, reason: 'No preview' })).toThrow();
    expect(() => decode({ expectedProductRevision: 1, impactBasis: ' ', productRef, reason: 'No preview' })).toThrow();
  });

  it('rejects cross-tenant assignment and keeps Action authorization explicit', () => {
    expect(() =>
      Schema.decodeUnknownSync(SetProductTypePayloadSchema)({
        expectedProductRevision: 1,
        impactBasis: 'sha256:population-1',
        nextProductTypeRef: { ...nextProductTypeRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        productRef,
        reason: 'Invalid tenant',
      }),
    ).toThrow();
    expect(setProductTypeAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(setProductTypeAction.descriptor.idempotency).toBe('required');
    expect(setProductTypeAction.descriptor.legalEntityScope).toBe('forbidden');
  });
});
