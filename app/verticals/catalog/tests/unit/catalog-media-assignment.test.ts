import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CatalogDocumentOwnerRevisionSchema,
  CatalogMediaAssignmentSchema,
  evaluateCatalogCurrentUse,
  selectCatalogMediaSet,
} from '../../shared/domain/catalog-media-assignment.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const product = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variant = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const resourceRef = {
  moduleId: 'documents.center',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'documents.center.resource',
  tenantId,
} as const;
const decode = Schema.decodeUnknownSync(CatalogMediaAssignmentSchema);
const assignment = decode({
  assignmentId: '55555555-5555-4555-8555-555555555555',
  assignmentRevision: 1,
  order: 2,
  purpose: 'PHOTOGRAPH',
  resourceRef,
  target: product,
});

describe('Catalog media assignments', () => {
  it('requires stable identity, revision, positive order, purpose, and owner-qualified same-Tenant reference', () => {
    expect(() => decode({ ...assignment, assignmentRevision: 0 })).toThrow();
    expect(() => decode({ ...assignment, order: 0 })).toThrow();
    expect(() => decode({ ...assignment, purpose: ' ' })).toThrow();
    expect(() => decode({ ...assignment, resourceRef: { ...resourceRef, resourceType: 'other.resource' } })).toThrow();
    expect(() => decode({ ...assignment, resourceRef: { ...resourceRef, tenantId: variant.resourceId } })).toThrow();
  });

  it('uses the whole Variant set when present and otherwise uses ordered Product fallback', () => {
    const drawing = decode({
      ...assignment,
      assignmentId: '66666666-6666-4666-8666-666666666666',
      order: 1,
      purpose: 'DRAWING',
    });
    const own = decode({
      ...assignment,
      assignmentId: '77777777-7777-4777-8777-777777777777',
      order: 3,
      target: variant,
    });
    const fallback = selectCatalogMediaSet([assignment, drawing], []);
    expect(fallback.source).toBe('PRODUCT');
    expect(fallback.illustrativeFallback).toBe(true);
    expect(fallback.main?.purpose).toBe('DRAWING');
    expect(selectCatalogMediaSet([assignment, drawing], [own]).ordered).toEqual([own]);
    expect(selectCatalogMediaSet([assignment, drawing], [own]).illustrativeFallback).toBe(false);
    expect(selectCatalogMediaSet([assignment], []).main).toEqual(assignment);
    expect(selectCatalogMediaSet([], []).main).toBeUndefined();
  });

  it('does not confuse absence of an assignment with owner absence, access denial or outage', () => {
    expect(evaluateCatalogCurrentUse(assignment).kind).toBe('OWNER_CHECK_REQUIRED');
    for (const kind of ['ABSENT', 'FORBIDDEN', 'UNAVAILABLE', 'CURRENT_UNVERIFIED'] as const) {
      expect(evaluateCatalogCurrentUse(assignment, { kind, resourceRef }).kind).toBe(kind);
    }
    expect(selectCatalogMediaSet([assignment], []).main).toEqual(assignment);
  });

  it('treats a different Resource as an explicit relationship mismatch, never a new version', () => {
    expect(
      evaluateCatalogCurrentUse(assignment, {
        kind: 'ABSENT',
        resourceRef: { ...resourceRef, resourceId: variant.resourceId },
      }).kind,
    ).toBe('RESOURCE_MISMATCH');
    const otherResourceRef = { ...resourceRef, resourceId: variant.resourceId } as const;
    const otherRevision = Schema.decodeUnknownSync(CatalogDocumentOwnerRevisionSchema)({
      resourceRef: otherResourceRef,
      revision: 2,
    });
    expect(
      evaluateCatalogCurrentUse(assignment, {
        current: otherRevision,
        kind: 'AVAILABLE',
        resourceRef: otherResourceRef,
      }).kind,
    ).toBe('RESOURCE_MISMATCH');
  });

  it('exposes only the owner-issued Current revision for the exact assigned Resource', () => {
    const current = Schema.decodeUnknownSync(CatalogDocumentOwnerRevisionSchema)({
      resourceRef,
      revision: 2,
      revisionId: '66666666-6666-4666-8666-666666666666',
    });
    const use = evaluateCatalogCurrentUse(assignment, { current, kind: 'AVAILABLE', resourceRef });
    expect(use).toMatchObject({ current: { revision: 2 }, kind: 'AVAILABLE' });
  });
});
