import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { PackageDefinitionRefSchema } from '../../shared/resources/package-definition.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const resourceId = '55555555-5555-4555-8555-555555555555';
const definition = {
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: 'commerce.catalog.package-definition',
  tenantId,
};

describe('Package Definition resource', () => {
  it('decodes a tenant-qualified stable identity for both definition and Option role', () => {
    expect(Schema.decodeUnknownSync(PackageDefinitionRefSchema)(definition)).toEqual(definition);
  });

  it('rejects a non-UUID identity or another resource type', () => {
    expect(() => Schema.decodeUnknownSync(PackageDefinitionRefSchema)({ ...definition, resourceId: 'box' })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PackageDefinitionRefSchema)({
        ...definition,
        resourceType: 'commerce.catalog.package-option',
      }),
    ).toThrow();
  });

  it('rejects a missing Tenant scope', () => {
    expect(() =>
      Schema.decodeUnknownSync(PackageDefinitionRefSchema)({
        moduleId: definition.moduleId,
        resourceId: definition.resourceId,
        resourceType: definition.resourceType,
      }),
    ).toThrow();
  });
});
