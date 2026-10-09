import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { LegalEntityRefSchema } from '../../src/resources/legal-entity.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const resourceId = '00000000-0000-4000-8000-000000000002';
const ref = {
  moduleId: 'core.identity',
  resourceId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
};

it('round-trips the stable tenant-scoped Core Legal Entity ResourceRef identity', () => {
  const decoded = Schema.decodeUnknownSync(LegalEntityRefSchema)(ref);
  expect(Schema.encodeSync(LegalEntityRefSchema)(decoded)).toEqual(ref);
});

it('rejects another owner, resource type, or non-UUID identity', () => {
  for (const invalid of [
    { ...ref, moduleId: 'party.registry' },
    { ...ref, resourceType: 'party.registry.party' },
    { ...ref, resourceId: 'not-a-uuid' },
    { ...ref, tenantId: 'not-a-uuid' },
  ]) {
    expect(() => Schema.decodeUnknownSync(LegalEntityRefSchema)(invalid)).toThrow();
  }
});
