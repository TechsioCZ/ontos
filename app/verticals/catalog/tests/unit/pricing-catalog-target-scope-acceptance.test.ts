import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ProductVariantSnapshotRequestSchema,
  ProductVariantSnapshotResponseSchema,
} from '../../shared/apis/product-variant-snapshot.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const capturedAt = '2026-09-27T10:00:00.000Z';

const catalogRef = <const ResourceType extends string>(
  resourceId: string,
  resourceType: ResourceType,
  refTenantId = tenantId,
) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId: refTenantId,
});

const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const otherProductRef = catalogRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'commerce.catalog.product');
const firstVariantRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant');
const laterVariantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');

const evidenceFor = (target: {
  readonly productRef: typeof productRef;
  readonly variantRef: typeof firstVariantRef;
}) => {
  const variantRevision = { resourceRef: target.variantRef, revision: 1 };
  return {
    assessedAt: capturedAt,
    basis: [
      { role: 'PRODUCT' as const, source: { resourceRef: target.productRef, revision: 7 } },
      { role: 'VARIANT' as const, source: variantRevision },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
        role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
        source: { resourceRef: target.productRef, revision: 7 },
      },
    ],
    membership: {
      attestationId: `catalog-membership:${target.variantRef.resourceId}`,
      observedAt: capturedAt,
      productRef: target.productRef,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      variant: variantRevision,
    },
    purpose: 'PRICING' as const,
    selection: target,
    status: 'VALID' as const,
  };
};

const targetFor = (variantRef: typeof firstVariantRef, parentRef = productRef) => ({
  catalogEvidence: evidenceFor({ productRef: parentRef, variantRef }),
  target: { productRef: parentRef, variantRef },
  targetId: variantRef.resourceId,
});

const responseFor = (targets: readonly unknown[] = [targetFor(firstVariantRef)], snapshotId = 'a'.repeat(64)) => ({
  capturedAt,
  catalogOwnerRevision: 'catalog-product-active-variants:17',
  productRef,
  snapshotId,
  targets,
  targetSetCompleteness: {
    observedAt: capturedAt,
    ownerRevision: 'catalog-product-active-variants:17',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-product:active-variants' },
  },
});

const decodeRequest = Schema.decodeUnknownSync(ProductVariantSnapshotRequestSchema, {
  onExcessProperty: 'error',
});
const decodeResponse = Schema.decodeUnknownSync(ProductVariantSnapshotResponseSchema, {
  onExcessProperty: 'error',
});

describe('Catalog owner snapshot for Pricing Product administration', () => {
  it('returns a concrete Variant even for a one-Variant Product', () => {
    const snapshot = decodeResponse(responseFor());

    expect(snapshot.targets).toHaveLength(1);
    expect(snapshot.targets[0]?.target).toEqual({ productRef, variantRef: firstVariantRef });
    expect(snapshot.targets[0]?.targetId).toBe(firstVariantRef.resourceId);
  });

  it('rejects Product-only, cross-Tenant, and invalid-parentage snapshot targets', () => {
    const productOnly = {
      catalogEvidence: evidenceFor({ productRef, variantRef: firstVariantRef }),
      target: { productRef },
      targetId: firstVariantRef.resourceId,
    };
    expect(() => decodeResponse(responseFor([productOnly]))).toThrow();

    expect(() =>
      decodeResponse(
        responseFor([targetFor({ ...firstVariantRef, tenantId: '99999999-9999-4999-8999-999999999999' })]),
      ),
    ).toThrow();
    expect(() => decodeResponse(responseFor([targetFor(firstVariantRef, otherProductRef)]))).toThrow();
  });

  it('fixes the target set at capture time and does not add a later Variant on retry', () => {
    const captured = decodeResponse(responseFor());
    const laterObservation = decodeResponse(
      responseFor([targetFor(firstVariantRef), targetFor(laterVariantRef)], 'b'.repeat(64)),
    );

    expect(captured.snapshotId).not.toBe(laterObservation.snapshotId);
    expect(captured.targets.map(({ targetId }) => targetId)).toEqual([firstVariantRef.resourceId]);
    expect(laterObservation.targets.map(({ targetId }) => targetId)).toEqual([
      firstVariantRef.resourceId,
      laterVariantRef.resourceId,
    ]);
    expect(captured.targets).toHaveLength(1);
  });

  it('requires stable unique target identity in deterministic Variant order', () => {
    expect(() => decodeResponse(responseFor([targetFor(laterVariantRef), targetFor(firstVariantRef)]))).toThrow();
    expect(() => decodeResponse(responseFor([targetFor(firstVariantRef), targetFor(firstVariantRef)]))).toThrow();
    expect(() =>
      decodeResponse(responseFor([{ ...targetFor(firstVariantRef), targetId: laterVariantRef.resourceId }])),
    ).toThrow();
  });

  it('is independent of Storefront or application identity', () => {
    expect(decodeRequest({ productRef })).toEqual({ productRef });
    expect(() => decodeRequest({ applicationId: 'shop-web', productRef })).toThrow();
    expect(() => decodeRequest({ productRef, storefrontId: 'storefront-cz' })).toThrow();
  });
});
