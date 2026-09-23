import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { BrandRefSchema, brandResourceDescriptor } from '../../shared/resources/brand.ts';

const brandRef = {
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.brand',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('Catalog Brand resource', () => {
  it('decodes a stable Tenant-qualified Brand reference', () => {
    expect(Schema.decodeUnknownSync(BrandRefSchema)(brandRef)).toEqual(brandRef);
    expect(brandResourceDescriptor.key).toBe(brandRef.resourceType);
  });

  it('rejects non-UUID identity, missing Tenant scope, and another resource kind', () => {
    expect(() => Schema.decodeUnknownSync(BrandRefSchema)({ ...brandRef, resourceId: 'Alfa' })).toThrow();
    expect(() => Schema.decodeUnknownSync(BrandRefSchema)({ ...brandRef, tenantId: 'tenant-a' })).toThrow();
    const { tenantId: _tenantId, ...withoutTenant } = brandRef;
    expect(() => Schema.decodeUnknownSync(BrandRefSchema)(withoutTenant)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrandRefSchema)({ ...brandRef, resourceType: 'commerce.catalog.product' }),
    ).toThrow();
  });
});
