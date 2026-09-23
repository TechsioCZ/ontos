import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { BrandCurrentRequestSchema, BrandCurrentResponseSchema } from '../../shared/apis/brand-current.ts';
import { BrandHistoryRequestSchema } from '../../shared/apis/brand-history.ts';
import { ProductBrandCurrentResponseSchema } from '../../shared/apis/product-brand-current.ts';
import { ProductBrandHistoryResponseSchema } from '../../shared/apis/product-brand-history.ts';
import { ManufacturerRelationHistoryRequestSchema } from '../../shared/apis/manufacturer-relation-history.ts';
import { ManufacturerRelationCurrentRequestSchema } from '../../shared/apis/manufacturer-relation-current.ts';
import { brandCurrentEntrypoint } from '../../src/api/brand-current.read.ts';
import { brandHistoryEntrypoint } from '../../src/api/brand-history.read.ts';
import { productBrandCurrentEntrypoint } from '../../src/api/product-brand-current.read.ts';
import { productBrandHistoryEntrypoint } from '../../src/api/product-brand-history.read.ts';
import { manufacturerRelationHistoryEntrypoint } from '../../src/api/manufacturer-relation-history.read.ts';
import { manufacturerRelationCurrentEntrypoint } from '../../src/api/manufacturer-relation-current.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const resourceId = '22222222-2222-4222-8222-222222222222';
const brandRef = { moduleId: 'commerce.catalog', resourceId, resourceType: 'commerce.catalog.brand', tenantId };
const productRef = { moduleId: 'commerce.catalog', resourceId, resourceType: 'commerce.catalog.product', tenantId };

describe('Brand and Manufacturer governed read contracts', () => {
  it('keeps Current reads separate from explicitly historical entrypoints', () => {
    expect(brandCurrentEntrypoint.access).toBe('read');
    expect(productBrandCurrentEntrypoint.access).toBe('read');
    expect(brandHistoryEntrypoint.access).toBe('historical_read');
    expect(productBrandHistoryEntrypoint.access).toBe('historical_read');
    expect(manufacturerRelationHistoryEntrypoint.access).toBe('historical_read');
    expect(manufacturerRelationCurrentEntrypoint.access).toBe('read');
  });

  it('requires typed Brand and Product targets, rejecting a cross-kind reference', () => {
    expect(Schema.is(BrandCurrentRequestSchema)({ brandRef })).toBe(true);
    expect(Schema.is(BrandHistoryRequestSchema)({ brandRef })).toBe(true);
    expect(Schema.is(BrandCurrentRequestSchema)({ brandRef: productRef })).toBe(false);
  });

  it('preserves unknown, confirmed unbranded, and identified Brand as distinct wire facts', () => {
    for (const assignment of [{ kind: 'unknown' }, { kind: 'confirmed_unbranded' }, { brandRef, kind: 'brand' }]) {
      expect(Schema.is(ProductBrandCurrentResponseSchema)({ assignment, productRef, revision: 1 })).toBe(true);
      expect(
        Schema.is(ProductBrandHistoryResponseSchema)({
          revisions: [
            {
              actingPrincipalId: resourceId,
              actionInvocationId: resourceId,
              assignment,
              evidenceRef: null,
              productRef,
              reason: 'Evidence',
              recordedAt: '2026-09-17T00:00:00.000Z',
              revision: 1,
            },
          ],
        }),
      ).toBe(true);
    }
    expect(
      Schema.is(ProductBrandCurrentResponseSchema)({ assignment: { kind: 'brand' }, productRef, revision: 1 }),
    ).toBe(false);
  });

  it('does not place owner identity or contact data on Brand Current', () => {
    expect(
      Schema.is(BrandCurrentResponseSchema)({
        assignable: true,
        brandRef,
        lifecycleState: 'ACTIVE',
        name: 'Alfa',
        recordedAt: '2026-09-17T00:00:00.000Z',
        revision: 1,
      }),
    ).toBe(true);
    expect(Schema.is(ManufacturerRelationHistoryRequestSchema)({ relationId: resourceId, subject: productRef })).toBe(
      true,
    );
    expect(Schema.is(ManufacturerRelationCurrentRequestSchema)({ subject: productRef })).toBe(true);
  });
});
