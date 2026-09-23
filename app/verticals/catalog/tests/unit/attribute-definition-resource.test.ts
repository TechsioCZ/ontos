import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  AttributeDefinitionRefSchema,
  attributeDefinitionResourceDescriptor,
} from '../../shared/resources/attribute-definition.ts';

const definitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;

describe('Attribute Definition resource', () => {
  it('has a stable Tenant-qualified identity separate from its label and subject values', () => {
    expect(Schema.decodeUnknownSync(AttributeDefinitionRefSchema)(definitionRef)).toEqual(definitionRef);
    expect(attributeDefinitionResourceDescriptor.key).toBe(definitionRef.resourceType);
  });

  it('rejects a label as identity, missing Tenant, and value or subject Resource types', () => {
    expect(Schema.is(AttributeDefinitionRefSchema)({ ...definitionRef, resourceId: 'Material' })).toBe(false);
    const { tenantId: _tenantId, ...withoutTenant } = definitionRef;
    expect(Schema.is(AttributeDefinitionRefSchema)(withoutTenant)).toBe(false);
    expect(
      Schema.is(AttributeDefinitionRefSchema)({
        ...definitionRef,
        resourceType: 'commerce.catalog.controlled-attribute-value',
      }),
    ).toBe(false);
    expect(
      Schema.is(AttributeDefinitionRefSchema)({ ...definitionRef, resourceType: 'commerce.catalog.product' }),
    ).toBe(false);
  });
});
