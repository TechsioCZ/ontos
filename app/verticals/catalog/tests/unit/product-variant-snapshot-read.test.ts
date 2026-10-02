import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ProductVariantSnapshotResponseSchema } from '../../shared/apis/product-variant-snapshot.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import { CatalogSelectionValidEvidenceSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { ProductVariantSnapshotServices } from '../../src/api/product-variant-snapshot.read.ts';
import { readProductVariantSnapshot } from '../../src/api/product-variant-snapshot.read.ts';
import type {
  ProductVariantSnapshotSource,
  ProductVariantSnapshotSourceValue,
} from '../../src/persistence/product-variant-snapshot-source.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const secondVariantId = '44444444-4444-4444-8444-444444444444';
const categoryId = '55555555-5555-4555-8555-555555555555';
const capturedAt = '2026-09-27T10:00:00.000Z';
const evidenceAssessedAt = '2026-09-27T10:00:00.123Z';
const defaultRevisions = { product: 7, variant: 3 } as const;

const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;

const source = (value: ProductVariantSnapshotSourceValue): ProductVariantSnapshotSource => ({
  readCurrent: () => Effect.succeed(Option.some(value)),
});

const validEvidence = (
  assessedAt: string,
  target: CatalogSelection,
  revisions: { readonly product: number; readonly variant: number } = defaultRevisions,
) =>
  Schema.decodeUnknownSync(CatalogSelectionValidEvidenceSchema)({
    assessedAt,
    basis: [
      { role: 'PRODUCT', source: { resourceRef: target.productRef, revision: revisions.product } },
      { role: 'VARIANT', source: { resourceRef: target.variantRef, revision: revisions.variant } },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: target.productRef, revision: revisions.product },
      },
      {
        role: 'CATEGORY',
        source: {
          resourceRef: {
            moduleId: 'commerce.catalog',
            resourceId: categoryId,
            resourceType: 'commerce.catalog.product-category',
            tenantId,
          },
          revision: 2,
        },
      },
    ],
    membership: {
      attestationId: `membership:${target.variantRef.resourceId}`,
      observedAt: assessedAt,
      productRef: target.productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: target.variantRef, revision: revisions.variant },
    },
    purpose: 'PRICING',
    selection: target,
    status: 'VALID',
  });

const services = (value: ProductVariantSnapshotSourceValue): ProductVariantSnapshotServices => ({
  assess: (request) => {
    const variantRevision = value.variants.find(
      ({ variantId: candidate }) => candidate === request.selection.variantRef.resourceId,
    )?.variantRevision;
    return variantRevision === undefined
      ? Effect.die('test source is missing the assessed Variant')
      : Effect.succeed({
          evidence: validEvidence(evidenceAssessedAt, request.selection, {
            product: value.productRevision,
            variant: variantRevision,
          }),
          missingRoles: [],
        });
  },
  source: source(value),
});

describe('Product Variant target snapshot read (#757)', () => {
  it.effect('issues one explicit Variant target with exact PRICING evidence and completeness', () =>
    Effect.gen(function* singleVariant() {
      const result = yield* readProductVariantSnapshot(
        { productRef },
        tenantId,
        services({ capturedAt, productRevision: 7, variants: [{ variantId, variantRevision: 3 }] }),
      );

      expect(Schema.is(ProductVariantSnapshotResponseSchema)(result)).toBe(true);
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]).toMatchObject({
        catalogEvidence: { assessedAt: evidenceAssessedAt, purpose: 'PRICING', status: 'VALID' },
        target: { productRef, variantRef: { resourceId: variantId } },
        targetId: variantId,
      });
      expect(result.capturedAt).toBe(capturedAt);
      expect(result.targets[0]?.catalogEvidence.assessedAt).not.toBe(result.capturedAt);
      expect(result.targetSetCompleteness).toEqual({
        observedAt: result.capturedAt,
        ownerRevision: result.catalogOwnerRevision,
        scope: {
          kind: 'EXACT_PREDICATE',
          predicateRef: `commerce.catalog.product.active-variants:${tenantId}:${productId}`,
        },
      });
      expect(result.snapshotId).toMatch(/^[0-9a-f]{64}$/u);
    }),
  );

  it.effect('keeps a captured target set fixed and changes its identity for a later Variant', () =>
    Effect.gen(function* fixedSnapshot() {
      const original = yield* readProductVariantSnapshot(
        { productRef },
        tenantId,
        services({ capturedAt, productRevision: 7, variants: [{ variantId, variantRevision: 3 }] }),
      );
      const repeated = yield* readProductVariantSnapshot(
        { productRef },
        tenantId,
        services({ capturedAt, productRevision: 7, variants: [{ variantId, variantRevision: 3 }] }),
      );
      const later = yield* readProductVariantSnapshot(
        { productRef },
        tenantId,
        services({
          capturedAt: '2026-09-27T10:01:00.000Z',
          productRevision: 8,
          variants: [
            { variantId, variantRevision: 3 },
            { variantId: secondVariantId, variantRevision: 1 },
          ],
        }),
      );

      expect(repeated.snapshotId).toBe(original.snapshotId);
      expect(original.targets.map(({ targetId }) => targetId)).toEqual([variantId]);
      expect(later.snapshotId).not.toBe(original.snapshotId);
      expect(later.targets.map(({ targetId }) => targetId)).toEqual([variantId, secondVariantId]);
    }),
  );

  it.effect('rejects foreign Products and empty target sets without estimating a Variant', () =>
    Effect.gen(function* failClosed() {
      let reads = 0;
      const foreign = yield* readProductVariantSnapshot(
        { productRef: { ...productRef, tenantId: foreignTenantId } },
        tenantId,
        {
          ...services({ capturedAt, productRevision: 7, variants: [{ variantId, variantRevision: 3 }] }),
          source: {
            readCurrent: () => {
              reads += 1;
              return Effect.die('foreign Product must not be read');
            },
          },
        },
      ).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(foreign)).toBe(true);
      expect(reads).toBe(0);

      const empty = yield* readProductVariantSnapshot(
        { productRef },
        tenantId,
        services({ capturedAt, productRevision: 7, variants: [] }),
      ).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(empty)).toBe(true);
    }),
  );

  it.effect('fails the complete snapshot when one exact target is not VALID', () =>
    Effect.gen(function* invalidTarget() {
      const failure = yield* readProductVariantSnapshot({ productRef }, tenantId, {
        assess: ({ selection }) =>
          Effect.succeed({
            evidence: {
              assessedAt: evidenceAssessedAt,
              basis: [],
              purpose: 'PRICING',
              reason: 'Variant parentage is unavailable',
              selection,
              status: 'INDETERMINATE' as const,
            },
            missingRoles: ['PRODUCT' as const, 'VARIANT' as const],
          }),
        source: source({ capturedAt, productRevision: 7, variants: [{ variantId, variantRevision: 3 }] }),
      }).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('fails closed when exact evidence revisions do not bind the source cut', () =>
    Effect.gen(function* mismatchedEvidenceRevision() {
      const failure = yield* readProductVariantSnapshot({ productRef }, tenantId, {
        assess: ({ selection }) =>
          Effect.succeed({
            evidence: validEvidence(evidenceAssessedAt, selection, { product: 7, variant: 4 }),
            missingRoles: [],
          }),
        source: source({ capturedAt, productRevision: 7, variants: [{ variantId, variantRevision: 3 }] }),
      }).pipe(Effect.flip);

      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('fails closed when the target set drifts during evidence preparation', () =>
    Effect.gen(function* changedTargetSet() {
      let reads = 0;
      const initial = {
        capturedAt,
        productRevision: 7,
        variants: [{ variantId, variantRevision: 3 }],
      } as const;
      const changed = {
        capturedAt: '2026-09-27T10:00:01.000Z',
        productRevision: 7,
        variants: [
          { variantId, variantRevision: 3 },
          { variantId: secondVariantId, variantRevision: 1 },
        ],
      } as const;
      const failure = yield* readProductVariantSnapshot({ productRef }, tenantId, {
        assess: ({ selection }) =>
          Effect.succeed({ evidence: validEvidence(evidenceAssessedAt, selection), missingRoles: [] }),
        source: {
          readCurrent: () => {
            reads += 1;
            return Effect.succeed(Option.some(reads === 1 ? initial : changed));
          },
        },
      }).pipe(Effect.flip);

      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(reads).toBe(2);
    }),
  );
});
