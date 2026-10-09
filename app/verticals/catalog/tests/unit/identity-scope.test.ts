import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { CatalogIdentityScopeSchema } from '../../shared/domain/identity-scope.ts';
import type { CatalogIdentityScope } from '../../shared/domain/identity-scope.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';

const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;

const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;

describe('Catalog identity scope', () => {
  it('keeps Product and Variant identity in one Tenant without a legal-entity dimension', () => {
    const decode = Schema.decodeUnknownSync(CatalogIdentityScopeSchema, { onExcessProperty: 'error' });
    const identity: CatalogIdentityScope = decode({ productRef, variantRef });

    expect(identity).toEqual({ productRef, variantRef });
    expect(Object.keys(identity)).toEqual(['productRef', 'variantRef']);
    expect(identity.productRef.tenantId).toBe(identity.variantRef.tenantId);
    expect(() => decode({ ...identity, sellingLegalEntityId: 'legal-entity-must-not-scope-catalog' })).toThrow();
  });

  it('rejects a Product and Variant pair that crosses the Tenant boundary', () => {
    const decode = Schema.decodeUnknownSync(CatalogIdentityScopeSchema);

    expect(() => decode({ productRef, variantRef: { ...variantRef, tenantId: otherTenantId } })).toThrow();
  });

  it('publishes an independently stable, tenant-qualified VariantRef', () => {
    const decode = Schema.decodeUnknownSync(VariantRefSchema, { onExcessProperty: 'error' });

    expect(decode(variantRef)).toEqual(variantRef);
    expect(() => decode({ ...variantRef, resourceId: ` ${variantId}` })).toThrow();
    expect(() => decode({ ...variantRef, privateCatalogId: 'not-public', tenantId: otherTenantId })).toThrow();
  });
});
