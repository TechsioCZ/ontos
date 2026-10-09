import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AssortmentSelectionAssessmentV1ResponseSchema } from '../../shared/apis/assortment-selection-assessment-v1.ts';
import {
  CatalogSelectionEvidenceSchema,
  CatalogSelectionSchema,
  CatalogSelectionValidEvidenceSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelectionEvidenceServiceResult } from '../../src/persistence/catalog-selection-evidence-service.ts';
import type { AssortmentSelectionAssessmentV1Source } from '../../src/persistence/assortment-selection-assessment-v1.ts';
import { assessOrVerifyAssortmentSelectionV1 } from '../../src/persistence/assortment-selection-assessment-v1.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const productTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-type',
  tenantId,
};
const categoryRef = {
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product-category',
  tenantId,
};
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const at = '2026-09-28T08:00:00.000Z';
const validAssessment = (productRevision = 1) =>
  Schema.decodeUnknownSync(CatalogSelectionValidEvidenceSchema)({
    assessedAt: at,
    basis: [
      { role: 'PRODUCT', source: { resourceRef: productRef, revision: productRevision } },
      { role: 'VARIANT', source: { resourceRef: variantRef, revision: 1 } },
      { role: 'PRODUCT_TYPE', source: { resourceRef: productTypeRef, revision: 1 } },
      { role: 'CATEGORY', source: { resourceRef: categoryRef, revision: 1 } },
    ],
    membership: {
      attestationId: 'membership-1',
      observedAt: at,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: variantRef, revision: 1 },
    },
    purpose: 'ASSORTMENT',
    selection,
    status: 'VALID',
  });

const result = (
  evidence: CatalogSelectionEvidenceServiceResult['evidence'],
): CatalogSelectionEvidenceServiceResult => ({ evidence, missingRoles: [] });

const sourceWith = (
  evidence: CatalogSelectionEvidenceServiceResult['evidence'],
  calls: { purpose: 'ASSORTMENT'; selection: typeof selection }[] = [],
): AssortmentSelectionAssessmentV1Source => ({
  assess: (input) => {
    calls.push(input);
    return Effect.succeed(result(evidence));
  },
});

const decodeResponse = Schema.decodeUnknownSync(AssortmentSelectionAssessmentV1ResponseSchema);

it.effect('returns Catalog-owned ASSORTMENT assessment and source token without foreign owner evidence', () =>
  Effect.gen(function* assessmentAndProof() {
    const calls: { purpose: 'ASSORTMENT'; selection: typeof selection }[] = [];
    const response = yield* assessOrVerifyAssortmentSelectionV1(
      { operation: 'ASSESS', selection },
      tenantId,
      sourceWith(validAssessment(), calls),
    );
    expect(decodeResponse(response)).toMatchObject({
      assessment: { purpose: 'ASSORTMENT', status: 'VALID' },
      operation: 'ASSESS',
      sourceProof: {
        assessmentStatus: 'VALID',
        purpose: 'ASSORTMENT',
        selection,
        source: 'CATALOG_OWNER_CURRENT_READ',
      },
    });
    expect(calls).toEqual([{ purpose: 'ASSORTMENT', selection }]);
    expect('ownerEvidence' in response).toBe(false);
  }),
);

it.effect('mints source proofs for authoritative invalid decisions but not unavailable assessments', () =>
  Effect.gen(function* nonCurrentAssessments() {
    const invalid = Schema.decodeUnknownSync(CatalogSelectionEvidenceSchema)({
      assessedAt: at,
      basis: validAssessment().basis,
      purpose: 'ASSORTMENT',
      reason: 'Selected Product or Variant is retired',
      selection,
      status: 'INVALID',
    });
    const invalidResponse = yield* assessOrVerifyAssortmentSelectionV1(
      { operation: 'ASSESS', selection },
      tenantId,
      sourceWith(invalid),
    );
    expect(invalidResponse).toMatchObject({
      assessment: { status: 'INVALID' },
      operation: 'ASSESS',
      sourceProof: { assessmentStatus: 'INVALID' },
    });

    const unavailableResponse = yield* assessOrVerifyAssortmentSelectionV1(
      { operation: 'ASSESS', selection },
      tenantId,
      sourceWith({ kind: 'UNAVAILABLE', reason: 'Catalog Current basis is temporarily unavailable' }),
    );
    expect(unavailableResponse).toMatchObject({ assessment: { kind: 'UNAVAILABLE' }, operation: 'ASSESS' });
    expect('sourceProof' in unavailableResponse).toBe(false);
  }),
);

it.effect('verifies authoritative INVALID decisions as CURRENT and rejects changed negative evidence', () =>
  Effect.gen(function* invalidCurrentness() {
    const original = Schema.decodeUnknownSync(CatalogSelectionEvidenceSchema)({
      assessedAt: at,
      basis: validAssessment().basis,
      purpose: 'ASSORTMENT',
      reason: 'Selected Product or Variant is retired',
      selection,
      status: 'INVALID',
    });
    if (!('status' in original) || original.status !== 'INVALID') {
      throw new Error('Expected authoritative INVALID assessment');
    }
    const proof = {
      assessedAt: original.assessedAt,
      assessmentStatus: 'INVALID' as const,
      purpose: 'ASSORTMENT' as const,
      selection,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      sourceToken: original.basis,
    };
    const current = yield* assessOrVerifyAssortmentSelectionV1(
      { operation: 'VERIFY_CURRENT', sourceProof: proof },
      tenantId,
      sourceWith(original),
    );
    expect(current).toMatchObject({ operation: 'VERIFY_CURRENT', sourceProof: proof, status: 'CURRENT' });

    const changed = yield* assessOrVerifyAssortmentSelectionV1(
      { operation: 'VERIFY_CURRENT', sourceProof: proof },
      tenantId,
      sourceWith({ ...original, basis: validAssessment(2).basis }),
    );
    expect(changed).toMatchObject({
      assessment: { status: 'INVALID' },
      operation: 'VERIFY_CURRENT',
      status: 'STALE',
    });
  }),
);

it.effect('re-reads and returns CURRENT only for a matching material source token', () =>
  Effect.gen(function* sourceRevalidation() {
    const original = validAssessment();
    const proof = {
      assessedAt: original.assessedAt,
      assessmentStatus: 'VALID' as const,
      purpose: 'ASSORTMENT' as const,
      selection,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      sourceToken: original.basis,
    };
    const current = yield* assessOrVerifyAssortmentSelectionV1(
      { operation: 'VERIFY_CURRENT', sourceProof: proof },
      tenantId,
      sourceWith(original),
    );
    expect(current).toMatchObject({ operation: 'VERIFY_CURRENT', sourceProof: proof, status: 'CURRENT' });

    const changed = yield* assessOrVerifyAssortmentSelectionV1(
      { operation: 'VERIFY_CURRENT', sourceProof: proof },
      tenantId,
      sourceWith(validAssessment(2)),
    );
    expect(changed).toMatchObject({
      assessment: { status: 'VALID' },
      operation: 'VERIFY_CURRENT',
      status: 'STALE',
    });
  }),
);

it.effect('rejects source proofs whose assessment status or exact selection differs from the owner re-read', () =>
  Effect.gen(function* forgedProof() {
    const original = validAssessment();
    const proof = {
      assessedAt: original.assessedAt,
      assessmentStatus: 'VALID' as const,
      purpose: 'ASSORTMENT' as const,
      selection,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      sourceToken: original.basis,
    };
    const mismatchedStatus = yield* assessOrVerifyAssortmentSelectionV1(
      { operation: 'VERIFY_CURRENT', sourceProof: { ...proof, assessmentStatus: 'INVALID' } },
      tenantId,
      sourceWith(original),
    );
    expect(mismatchedStatus).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'STALE' });

    const mismatchedSelection = yield* assessOrVerifyAssortmentSelectionV1(
      {
        operation: 'VERIFY_CURRENT',
        sourceProof: {
          ...proof,
          selection: {
            ...selection,
            variantRef: { ...variantRef, resourceId: '66666666-6666-4666-8666-666666666666' },
          },
        },
      },
      tenantId,
      sourceWith(original),
    );
    expect(mismatchedSelection).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'STALE' });
  }),
);

it.effect('distinguishes an unestablishable re-read from a changed source', () =>
  Effect.gen(function* unavailableVerification() {
    const original = validAssessment();
    const proof = {
      assessedAt: original.assessedAt,
      assessmentStatus: 'VALID' as const,
      purpose: 'ASSORTMENT' as const,
      selection,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      sourceToken: original.basis,
    };
    const unavailable = yield* assessOrVerifyAssortmentSelectionV1(
      { operation: 'VERIFY_CURRENT', sourceProof: proof },
      tenantId,
      sourceWith({ kind: 'UNAVAILABLE', reason: 'Catalog Current basis is temporarily unavailable' }),
    );
    expect(unavailable).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'UNAVAILABLE' });
  }),
);
