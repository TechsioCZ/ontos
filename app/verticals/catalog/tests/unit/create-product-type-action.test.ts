import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CreateProductTypePayloadSchema,
  CreateProductTypeResultSchema,
  createProductTypeAction,
} from '../../src/actions/create-product-type.action.ts';
import { ProductTypeCreateConflict } from '../../src/persistence/product-type-create-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product-type',
  tenantId,
} as const;

describe('Create Product Type Action contract', () => {
  it('requires a named definition, reason, and explicit initial rules', () => {
    const decode = Schema.decodeUnknownSync(CreateProductTypePayloadSchema);
    expect(decode({ name: 'Shelf', reason: 'Structured shelf data', rules: [] })).toEqual({
      name: 'Shelf',
      reason: 'Structured shelf data',
      rules: [],
    });
    expect(() => decode({ name: 'Shelf', reason: 'Structured shelf data' })).toThrow();
    expect(() => decode({ name: ' ', reason: 'Structured shelf data', rules: [] })).toThrow();
    expect(() => decode({ name: 'Shelf', reason: ' ', rules: [] })).toThrow();
  });

  it('returns a tenant-qualified Resource identity and exact initial revision', () => {
    const decode = Schema.decodeUnknownSync(CreateProductTypeResultSchema);
    expect(decode({ productTypeRef, revision: 1 })).toMatchObject({ productTypeRef, revision: 1 });
    expect(() => decode({ productTypeRef, revision: 0 })).toThrow();
    expect(() => decode({ productTypeRef: { ...productTypeRef, tenantId: 'invalid' }, revision: 1 })).toThrow();
  });

  it('declares exact typed persistence conflicts instead of a placeholder outcome', () => {
    const conflict = new ProductTypeCreateConflict({
      code: 'product_type_create_conflict',
      conflict: 'INVALID_RULES',
      reason: 'Invalid Product Type rules',
    });
    expect(Schema.is(createProductTypeAction.descriptor.domainErrorSchema)(conflict)).toBe(true);
  });

  it('remains an explicitly authorized tenant Action without legal-entity scope', () => {
    expect(createProductTypeAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(createProductTypeAction.descriptor.entrypoint.scope).toBe('tenant');
    expect(createProductTypeAction.descriptor.legalEntityScope).toBe('forbidden');
    expect(createProductTypeAction.descriptor.idempotency).toBe('required');
  });
});
