import { describe, expect, it } from 'effect-rstest';

import { recordProductBrand, renameBrand, transitionBrand } from '../../shared/domain/brand-facts.ts';
import type { BrandFact } from '../../shared/domain/brand-facts.ts';

const brandRef = { resourceId: 'brand-1', tenantId: 'tenant-a' };
const productRef = { resourceId: 'product-1', tenantId: 'tenant-a' };
const brand: BrandFact = {
  brandRef,
  lifecycle: 'ACTIVE',
  names: [{ name: 'Alfa Home', reason: 'Original name' }],
};

describe('Catalog Brand facts', () => {
  it('renames without changing identity or erasing the former name', () => {
    const result = renameBrand(brand, ' Alfa ', 'Continuing trade name');
    expect(result.status).toBe('CHANGED');
    if (!('brand' in result)) {
      return;
    }
    expect(result.brand.brandRef).toEqual(brandRef);
    expect(result.brand.names.map(({ name }) => name)).toEqual(['Alfa Home', 'Alfa']);
    expect(brand.names).toHaveLength(1);
  });

  it('retirement blocks a new assignment but preserves the previous link and reactivation identity', () => {
    const claim = { brandRef, evidenceRef: 'label-photo', kind: 'BRANDED' as const };
    const first = recordProductBrand([], productRef, claim, brand, 'Label evidence');
    expect(first.status).toBe('CHANGED');
    if (!('history' in first)) {
      return;
    }
    const retired = transitionBrand(brand, 'RETIRED', 'Confirmed retirement');
    expect(retired.status).toBe('CHANGED');
    if (!('brand' in retired)) {
      return;
    }
    expect(recordProductBrand([], productRef, claim, retired.brand, 'New assignment')).toEqual({
      status: 'BRAND_NOT_ASSIGNABLE',
    });
    expect(first.history[0]?.claim).toEqual(claim);
    const restored = transitionBrand(retired.brand, 'ACTIVE', 'Confirmed continuation');
    expect(restored.status).toBe('CHANGED');
    if ('brand' in restored) {
      expect(restored.brand.brandRef).toEqual(brandRef);
    }
  });

  it('distinguishes unknown from confirmed unbranded and keeps claim history', () => {
    const unknown = recordProductBrand([], productRef, { kind: 'UNKNOWN' }, undefined, 'Not known');
    if (!('history' in unknown)) {
      return;
    }
    const unbranded = recordProductBrand(
      unknown.history,
      productRef,
      { evidenceRef: 'inspection', kind: 'CONFIRMED_UNBRANDED' },
      undefined,
      'Inspected packaging',
    );
    expect(unbranded.status).toBe('CHANGED');
    if ('history' in unbranded) {
      expect(unbranded.history.map(({ claim }) => claim.kind)).toEqual(['UNKNOWN', 'CONFIRMED_UNBRANDED']);
    }
  });

  it('rejects cross-Tenant and retired Brand references and missing evidence', () => {
    const claim = { brandRef: { ...brandRef, tenantId: 'tenant-b' }, evidenceRef: 'label', kind: 'BRANDED' as const };
    expect(recordProductBrand([], productRef, claim, brand, 'Reason')).toEqual({
      status: 'TENANT_MISMATCH',
    });
    expect(
      recordProductBrand([], productRef, { evidenceRef: ' ', kind: 'CONFIRMED_UNBRANDED' }, undefined, 'Reason'),
    ).toEqual({
      status: 'EVIDENCE_REQUIRED',
    });
  });
});
