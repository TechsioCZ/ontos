import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AssignCatalogMediaPayloadSchema,
  ReorderCatalogMediaPayloadSchema,
  RemoveCatalogMediaPayloadSchema,
} from '../../shared/actions/catalog-media.ts';
import { catalogMediaOutcome, checkCatalogMediaScope } from '../../src/actions/catalog-media-action-support.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const subjectRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const resourceRef = {
  moduleId: 'documents.center',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'documents.center.resource',
  tenantId,
} as const;
const base = {
  assignmentId: '44444444-4444-4444-8444-444444444444',
  evidenceRefs: ['document-review:1'],
  expectedSetRevision: 0,
  reason: 'Approved catalog reference',
  subjectRef,
};

describe('Catalog media Action contracts', () => {
  it('requires explicit assignment identity, owner reference, purpose, order, and CAS revision', () => {
    const decode = Schema.decodeUnknownSync(AssignCatalogMediaPayloadSchema);
    const payload = { ...base, order: 1, purpose: 'PHOTO', resourceKind: 'MEDIA', resourceRef };
    expect(decode(payload).subjectRef).toEqual(subjectRef);
    expect(() => decode({ ...payload, order: 0 })).toThrow();
    expect(() => decode({ ...payload, expectedSetRevision: -1 })).toThrow();
    expect(() => decode({ ...payload, resourceRef: { ...resourceRef, tenantId: subjectRef.resourceId } })).toThrow();
    expect(() => decode({ ...payload, resourceRef: { ...resourceRef, resourceType: 'unqualified' } })).toThrow();
    expect(() => decode({ ...payload, purpose: '' })).toThrow();
  });

  it('keeps reorder and remove scoped to one explicit subject and assignment', () => {
    expect(Schema.decodeUnknownSync(ReorderCatalogMediaPayloadSchema)({ ...base, order: 2 }).order).toBe(2);
    expect(Schema.decodeUnknownSync(RemoveCatalogMediaPayloadSchema)(base).assignmentId).toBe(base.assignmentId);
  });

  it.effect('rejects cross-tenant mutation before owner-local persistence and keeps conflicts typed', () =>
    Effect.gen(function* catalogMediaActionContractsEffect() {
      expect(
        yield* Effect.flip(checkCatalogMediaScope('55555555-5555-4555-8555-555555555555', subjectRef)),
      ).toMatchObject({ code: 'catalog_media_not_found' });
      expect(yield* Effect.flip(catalogMediaOutcome({ _tag: 'revision_conflict', actualRevision: 3 }))).toMatchObject({
        actualRevision: 3,
        code: 'catalog_media_conflict',
      });
      expect(yield* catalogMediaOutcome({ _tag: 'removed', assignmentId: base.assignmentId, setRevision: 2 })).toEqual({
        assignmentId: base.assignmentId,
        setRevision: 2,
      });
    }),
  );
});
