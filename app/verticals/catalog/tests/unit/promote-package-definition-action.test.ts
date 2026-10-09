import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PromotePackageDefinitionPayloadSchema,
  PromotePackageDefinitionResultSchema,
} from '../../shared/actions/promote-package-definition.ts';

const resourceRef = {
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.package-definition',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const payload = {
  evidenceRefs: ['catalog-record:successor'],
  expectedCurrent: { resourceRef, revision: 1 },
  expectedOptionRevision: 0,
  reason: 'Successor is now effective',
  successor: { resourceRef, revision: 2 },
};

describe('Package successor promotion Action contract', () => {
  it('requires explicit Current, successor, Option revision, and evidence', () => {
    expect(Schema.decodeUnknownSync(PromotePackageDefinitionPayloadSchema)(payload).successor.revision).toBe(2);
    expect(() =>
      Schema.decodeUnknownSync(PromotePackageDefinitionPayloadSchema)({ ...payload, successor: null }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PromotePackageDefinitionPayloadSchema)({ ...payload, expectedOptionRevision: -1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PromotePackageDefinitionPayloadSchema)({ ...payload, evidenceRefs: [] }),
    ).toThrow();
  });

  it('returns the exact promoted content and Option role revisions', () => {
    const result = Schema.decodeUnknownSync(PromotePackageDefinitionResultSchema)({
      contentRevision: payload.successor,
      definitionRef: resourceRef,
      optionRevision: 1,
    });
    expect(result.contentRevision.revision).toBe(2);
    expect(result.optionRevision).toBe(1);
  });
});
