import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CatalogAcceptedDocumentBasisSchema,
  catalogDocumentSafeExplanation,
  catalogLiveReferencePreservesAcceptedBasis,
  compareCatalogAcceptedDocumentBasis,
  evaluateCatalogDocumentReadAccess,
  sameCatalogAcceptedDocumentBasis,
} from '../../shared/domain/catalog-document-reference.ts';
import {
  CatalogDocumentOwnerRevisionSchema,
  CatalogMediaAssignmentSchema,
  evaluateCatalogCurrentUse,
} from '../../shared/domain/catalog-media-assignment.ts';
import type { CatalogCurrentUse } from '../../shared/domain/catalog-media-assignment.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const product = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const otherTenantId = '33333333-3333-4333-8333-333333333333';
const resourceD1 = {
  moduleId: 'documents.center',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'documents.center.resource',
  tenantId,
} as const;
const resourceD2 = { ...resourceD1, resourceId: '55555555-5555-4555-8555-555555555555' } as const;

const assignment = Schema.decodeUnknownSync(CatalogMediaAssignmentSchema)({
  assignmentId: '66666666-6666-4666-8666-666666666666',
  assignmentRevision: 1,
  order: 1,
  purpose: 'instruction manual',
  resourceRef: resourceD1,
  target: product,
});

const ownerRevision = (resourceRef: typeof resourceD1 | typeof resourceD2, revision: number) =>
  Schema.decodeUnknownSync(CatalogDocumentOwnerRevisionSchema)({
    resourceRef,
    revision,
    revisionId: '77777777-7777-4777-8777-777777777777',
  });

const availabilityD1 = (revision: number): CatalogCurrentUse =>
  evaluateCatalogCurrentUse(assignment, {
    current: ownerRevision(resourceD1, revision),
    kind: 'AVAILABLE',
    resourceRef: resourceD1,
  });

const acceptedBasis = Schema.decodeUnknownSync(CatalogAcceptedDocumentBasisSchema)({
  acceptedAt: '2026-01-02T03:04:05.000Z',
  exact: { resourceRef: resourceD1, revision: 1, revisionId: '77777777-7777-4777-8777-777777777777' },
  historical: true,
  purpose: 'instruction manual',
  target: product,
});

describe('Catalog document references', () => {
  it('resolves a live reference to the owner-issued newest Current version without a Catalog approval', () => {
    const live = availabilityD1(2);
    expect(live).toMatchObject({ current: { revision: 2 }, kind: 'AVAILABLE' });
    expect(live.assignment.resourceRef).toEqual(resourceD1);
    expect(live.assignment).not.toHaveProperty('version');
    // The assignment records no pinned version and no per-version Catalog decision.
    expect(assignment.assignmentRevision).toBe(1);
  });

  it('never treats a separately named Resource as a new version of the assigned one', () => {
    const wrongResource = evaluateCatalogCurrentUse(assignment, {
      current: ownerRevision(resourceD2, 2),
      kind: 'AVAILABLE',
      resourceRef: resourceD2,
    });
    expect(wrongResource.kind).toBe('RESOURCE_MISMATCH');
    expect(compareCatalogAcceptedDocumentBasis(acceptedBasis, wrongResource)).toEqual({ kind: 'DIFFERENT_RESOURCE' });
  });

  it('keeps an Accepted V1 basis explaining V1 while the live detail resolves D1 V2', () => {
    const comparison = compareCatalogAcceptedDocumentBasis(acceptedBasis, availabilityD1(2));
    expect(comparison).toEqual({
      accepted: acceptedBasis.exact,
      kind: 'DIFFERENT_VERSION',
      live: { resourceRef: resourceD1, revision: 2, revisionId: '77777777-7777-4777-8777-777777777777' },
    });
    expect(catalogLiveReferencePreservesAcceptedBasis(comparison)).toBe(false);
    const exact = compareCatalogAcceptedDocumentBasis(acceptedBasis, availabilityD1(1));
    expect(catalogLiveReferencePreservesAcceptedBasis(exact)).toBe(true);
  });

  it('stays indeterminate when the owner Current is not supplied or not verifiable', () => {
    const missing = evaluateCatalogCurrentUse(assignment);
    expect(missing.kind).toBe('OWNER_CHECK_REQUIRED');
    const unverified = evaluateCatalogCurrentUse(assignment, { kind: 'CURRENT_UNVERIFIED', resourceRef: resourceD1 });
    expect(compareCatalogAcceptedDocumentBasis(acceptedBasis, missing)).toMatchObject({ kind: 'INDETERMINATE' });
    expect(compareCatalogAcceptedDocumentBasis(acceptedBasis, unverified)).toMatchObject({ kind: 'INDETERMINATE' });
    expect(
      catalogLiveReferencePreservesAcceptedBasis(compareCatalogAcceptedDocumentBasis(acceptedBasis, missing)),
    ).toBe(false);
  });

  it('compares Accepted bases by exact owner revision identity and never merges two bases', () => {
    const clone = Schema.decodeUnknownSync(CatalogAcceptedDocumentBasisSchema)(acceptedBasis);
    expect(sameCatalogAcceptedDocumentBasis(acceptedBasis, clone)).toBe(true);
    const newer = Schema.decodeUnknownSync(CatalogAcceptedDocumentBasisSchema)({
      ...acceptedBasis,
      exact: { ...acceptedBasis.exact, revision: 2 },
    });
    expect(sameCatalogAcceptedDocumentBasis(acceptedBasis, newer)).toBe(false);
    const otherTarget = Schema.decodeUnknownSync(CatalogAcceptedDocumentBasisSchema)({
      ...acceptedBasis,
      target: { ...product, resourceId: '88888888-8888-4888-8888-888888888888' },
    });
    expect(sameCatalogAcceptedDocumentBasis(acceptedBasis, otherTarget)).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(CatalogAcceptedDocumentBasisSchema)({
        ...acceptedBasis,
        exact: { ...acceptedBasis.exact, resourceRef: { ...resourceD1, tenantId: otherTenantId } },
      }),
    ).toThrow();
  });

  it('never grants a read from a valid Catalog reference alone', () => {
    expect(evaluateCatalogDocumentReadAccess()).toEqual({ kind: 'REFERENCE_DOES_NOT_GRANT' });
    expect(evaluateCatalogDocumentReadAccess('UNVERIFIED')).toEqual({ kind: 'REFERENCE_DOES_NOT_GRANT' });
    expect(evaluateCatalogDocumentReadAccess('DENIED')).toEqual({ kind: 'OWNER_DENIED' });
    expect(evaluateCatalogDocumentReadAccess('GRANTED')).toEqual({ kind: 'OWNER_GRANTED' });
  });

  it('keeps absence, outage, unverifiable Current, and denied access distinct but safely explained', () => {
    const outcomes = [
      ['ABSENT', 'NOT_FOUND'],
      ['UNAVAILABLE', 'RETRYABLE'],
      ['CURRENT_UNVERIFIED', 'INDETERMINATE'],
      ['FORBIDDEN', 'DENIED'],
    ] as const;
    for (const [kind, explanation] of outcomes) {
      const reference = evaluateCatalogCurrentUse(assignment, { kind, resourceRef: resourceD1 });
      expect(reference.kind).toBe(kind);
      expect(catalogDocumentSafeExplanation(reference).kind).toBe(explanation);
    }
    const mismatch = evaluateCatalogCurrentUse(assignment, { kind: 'ABSENT', resourceRef: resourceD2 });
    // A different Resource is reported as indeterminate publicly, never as the other document's absence.
    expect(catalogDocumentSafeExplanation(mismatch).kind).toBe('INDETERMINATE');
    expect(catalogDocumentSafeExplanation(availabilityD1(2)).kind).toBe('AVAILABLE');
  });
});
