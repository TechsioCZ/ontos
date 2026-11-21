import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { assessCatalogPriceSourceSelection } from '../../src/persistence/catalog-price-source-selection.ts';
import type { CatalogPriceSourceSelectionRows } from '../../src/persistence/catalog-price-source-selection.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const productId = '22222222-2222-4222-8222-222222222222';
const selectionIn = (tenant: { readonly product: string; readonly variant: string }) =>
  Schema.decodeSync(CatalogSelectionSchema)({
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: productId,
      resourceType: 'commerce.catalog.product',
      tenantId: tenant.product,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.catalog.variant',
      tenantId: tenant.variant,
    },
  });
const selection = selectionIn({ product: tenantId, variant: tenantId });
const assessedAt = '2026-11-21T03:00:00.000Z';
const rowsOf = (
  product: 'ACTIVE' | 'DRAFT' | 'RETIRED',
  variant: 'ACTIVE' | 'RETIRED' | 'WORK_IN_PROGRESS',
  variantProductId = productId,
): CatalogPriceSourceSelectionRows => ({
  product: { lifecycleState: product, revision: 1 },
  variant: { lifecycleState: variant, productId: variantProductId, revision: 1 },
});
const assess = (rows: CatalogPriceSourceSelectionRows, requested = selection, trustedTenantId = tenantId) =>
  assessCatalogPriceSourceSelection({
    assessedAt,
    attestationId: '44444444-4444-4444-8444-444444444444',
    rows,
    selection: requested,
    tenantId: trustedTenantId,
  });

describe('Catalog price source selection', () => {
  it('accepts the exact DRAFT Product with its WORK_IN_PROGRESS Variant, membership only, no type proof', () => {
    const result = assess(rowsOf('DRAFT', 'WORK_IN_PROGRESS'));
    expect(result).toMatchObject({
      basis: [
        { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 1 } },
        { role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 1 } },
      ],
      membership: { observedAt: assessedAt, productRef: selection.productRef, source: 'CATALOG_OWNER_CURRENT_READ' },
      purpose: 'PRICE_SOURCE_ASSERTION',
      selection,
      status: 'VALID',
    });
  });

  it('accepts an ACTIVE pair too', () => {
    expect(assess(rowsOf('ACTIVE', 'ACTIVE'))).toMatchObject({ status: 'VALID' });
  });

  it('refuses a RETIRED Product and a RETIRED Variant', () => {
    expect(assess(rowsOf('RETIRED', 'WORK_IN_PROGRESS'))).toMatchObject({
      reason: 'Selected Product or Variant is retired',
      status: 'INVALID',
    });
    expect(assess(rowsOf('DRAFT', 'RETIRED'))).toMatchObject({
      reason: 'Selected Product or Variant is retired',
      status: 'INVALID',
    });
  });

  it('refuses a Variant of another Product', () => {
    expect(assess(rowsOf('DRAFT', 'WORK_IN_PROGRESS', '55555555-5555-4555-8555-555555555555'))).toMatchObject({
      reason: 'Variant belongs to another Product',
      status: 'INVALID',
    });
  });

  it('refuses a selection that names another Tenant, whatever the rows say', () => {
    const rows = rowsOf('DRAFT', 'WORK_IN_PROGRESS');
    const refused = {
      reason: 'A price source names a Product and Variant of another Tenant or owner',
      status: 'INVALID',
    };
    expect(assess(rows, selectionIn({ product: otherTenantId, variant: otherTenantId }))).toMatchObject(refused);
    expect(assess(rows, selection, otherTenantId)).toMatchObject(refused);
    // A pair split across Tenants is no Catalog selection at all.
    expect(() => selectionIn({ product: tenantId, variant: otherTenantId })).toThrow();
  });

  it('answers NOT_FOUND for a Product or Variant the Tenant does not hold', () => {
    const { product, variant } = rowsOf('DRAFT', 'WORK_IN_PROGRESS');
    expect(assess({ variant })).toEqual({ kind: 'NOT_FOUND', requested: selection });
    expect(assess({ product })).toEqual({ kind: 'NOT_FOUND', requested: selection });
  });

  it('refuses a selection that pins more than the exact Product and Variant', () => {
    const pinned = Schema.decodeSync(CatalogSelectionSchema)({
      ...selection,
      setComposition: {
        resourceRef: {
          moduleId: 'commerce.catalog',
          resourceId: '66666666-6666-4666-8666-666666666666',
          resourceType: 'commerce.catalog.set-composition',
          tenantId,
        },
        revision: 1,
      },
    });
    expect(assess(rowsOf('DRAFT', 'WORK_IN_PROGRESS'), pinned)).toMatchObject({ status: 'INVALID' });
  });
});
