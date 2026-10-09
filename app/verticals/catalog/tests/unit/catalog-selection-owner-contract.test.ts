import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  CatalogSelectionInjectedOwnerEvidenceSchema,
  CatalogSelectionOwnerAssessmentResultSchema,
  catalogSelectionInjectedOwnerEvidenceResult,
  catalogSelectionNotCatalogOwned,
} from '../../shared/domain/catalog-selection-owner-contract.ts';
import type { CatalogSelectionInjectedOwnerEvidence } from '../../shared/domain/catalog-selection-owner-contract.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const instant = '2026-09-18T12:00:00.000Z';

const decodeSelection = Schema.decodeUnknownSync(CatalogSelectionSchema);
const decodeInjected = Schema.decodeUnknownSync(CatalogSelectionInjectedOwnerEvidenceSchema, {
  onExcessProperty: 'error',
});
const decodeResult = Schema.decodeUnknownSync(CatalogSelectionOwnerAssessmentResultSchema, {
  onExcessProperty: 'error',
});
const selection = decodeSelection({ productRef, variantRef });
const request = { owner: 'PRICING', purpose: 'PRICING', selection } as const;
const injected = decodeInjected({
  evidenceId: 'pricing-evidence-1',
  observedAt: instant,
  owner: 'PRICING',
  ownerRevision: {
    moduleId: 'commerce.pricing',
    resourceId: 'price-resource-1',
    resourceType: 'commerce.pricing.price',
    revision: 1,
    tenantId,
  },
  purpose: 'PRICING',
  selection,
});

describe('Catalog Selection external owner contract', () => {
  it('types a foreign-owner fact as NOT_CATALOG_OWNED instead of fabricating a basis', () => {
    const result = catalogSelectionNotCatalogOwned({ owner: 'PRICING', purpose: 'PRICING', selection });
    expect(decodeResult(result)).toMatchObject({ kind: 'NOT_CATALOG_OWNED', owner: 'PRICING' });
    expect(decodeResult({ kind: 'UNAVAILABLE', reason: 'Owner offline' })).toMatchObject({ kind: 'UNAVAILABLE' });
  });

  it('preserves owner-qualified injected evidence only for the exact request', () => {
    const missing = new Map<string, CatalogSelectionInjectedOwnerEvidence>().get('missing');
    expect(catalogSelectionInjectedOwnerEvidenceResult(request, injected)).toBe(injected);
    expect(catalogSelectionInjectedOwnerEvidenceResult(request, missing)).toMatchObject({
      kind: 'UNVERIFIABLE_OWNER_EVIDENCE',
      owner: 'PRICING',
    });
  });

  it('fails closed on a foreign owner, other purpose, or other selection', () => {
    expect(catalogSelectionInjectedOwnerEvidenceResult({ ...request, owner: 'CART' }, injected)).toMatchObject({
      kind: 'UNVERIFIABLE_OWNER_EVIDENCE',
    });
    expect(catalogSelectionInjectedOwnerEvidenceResult({ ...request, purpose: 'ASSORTMENT' }, injected)).toMatchObject({
      kind: 'UNVERIFIABLE_OWNER_EVIDENCE',
    });
    const otherSelection = decodeSelection({
      productRef,
      variantRef: ref('commerce.catalog.variant', '99999999-9999-4999-8999-999999999999'),
    });
    expect(
      catalogSelectionInjectedOwnerEvidenceResult({ ...request, selection: otherSelection }, injected),
    ).toMatchObject({ kind: 'UNVERIFIABLE_OWNER_EVIDENCE' });
  });

  it('rejects an unknown owner, a Catalog-owned revision, and a cross-Tenant injection', () => {
    expect(() => decodeInjected({ ...injected, owner: 'WAREHOUSE' })).toThrow();
    expect(() =>
      decodeInjected({ ...injected, ownerRevision: { ...injected.ownerRevision, moduleId: 'commerce.catalog' } }),
    ).toThrow();
    expect(() =>
      decodeInjected({
        ...injected,
        ownerRevision: { ...injected.ownerRevision, tenantId: '99999999-9999-4999-8999-999999999999' },
      }),
    ).toThrow();
  });
});
