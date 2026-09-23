import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { CatalogRevisionInstantSchema } from '../../shared/domain/catalog-revision-reference.ts';
import {
  CatalogSelectionBasisListSchema,
  CatalogSelectionEvidenceSchema,
  CatalogSelectionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelectionValidityRequest } from '../../shared/domain/catalog-selection-validity.ts';
import {
  CatalogSelectionValidityAttestationSchema,
  catalogSelectionValidityAttestationFor,
  catalogSelectionValidityCovers,
} from '../../shared/domain/catalog-selection-validity.ts';

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
const selection = decodeSelection({ productRef, variantRef });
const membership = {
  attestationId: 'catalog-membership-1',
  observedAt: instant,
  productRef,
  source: 'CATALOG_OWNER_CURRENT_READ' as const,
  variant: { resourceRef: variantRef, revision: 2 },
};
const basis = [
  { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
  { role: 'VARIANT' as const, source: membership.variant },
  {
    provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
    role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
    source: { resourceRef: productRef, revision: 1 },
  },
];
const decodeEvidence = Schema.decodeUnknownSync(CatalogSelectionEvidenceSchema, { onExcessProperty: 'error' });
const validEvidence = decodeEvidence({
  assessedAt: instant,
  basis,
  membership,
  purpose: 'PURCHASE_ACCEPTANCE',
  selection,
  status: 'VALID',
});
const indeterminateEvidence = decodeEvidence({
  assessedAt: instant,
  basis,
  purpose: 'PURCHASE_ACCEPTANCE',
  reason: 'Current Product Type is unavailable',
  selection,
  status: 'INDETERMINATE',
});

const decodeBasis = Schema.decodeUnknownSync(CatalogSelectionBasisListSchema);
const decodeInstant = Schema.decodeUnknownSync(CatalogRevisionInstantSchema);
const request: CatalogSelectionValidityRequest = {
  at: validEvidence.assessedAt,
  purpose: 'PURCHASE_ACCEPTANCE',
  selection,
  sourceToken: validEvidence.basis,
};
const requireDefined = <Value>(value: Value | undefined): Value => {
  if (value === undefined) {
    throw new Error('Expected a defined value');
  }
  return value;
};

describe('Catalog Selection validity attestation', () => {
  it('mints a Catalog-issued, time-bounded guarantee only from fresh VALID evidence', () => {
    const windowed = catalogSelectionValidityAttestationFor({
      evidence: validEvidence,
      purpose: 'PURCHASE_ACCEPTANCE',
      validUntil: '2026-09-18T13:00:00.000Z',
    });
    expect(windowed).toBeDefined();
    expect(Schema.decodeUnknownSync(CatalogSelectionValidityAttestationSchema)(windowed)).toMatchObject({
      basis,
      guarantee: 'EXACT_SELECTION_AND_CURRENT_BASIS_UNCHANGED',
      onRetirement: 'INVALIDATE',
      onSourceChange: 'REASSESS',
      source: 'CATALOG_OWNER_CURRENT_READ',
      validUntil: '2026-09-18T13:00:00.000Z',
    });
    expect(catalogSelectionValidityCovers(requireDefined(windowed), request)).toBe(true);
    expect(
      catalogSelectionValidityCovers(requireDefined(windowed), {
        ...request,
        at: decodeInstant('2026-09-18T12:30:00.000Z'),
      }),
    ).toBe(true);
    expect(
      catalogSelectionValidityCovers(requireDefined(windowed), {
        ...request,
        at: decodeInstant('2026-09-18T13:00:00.000Z'),
      }),
    ).toBe(false);
  });

  it('does not cover another selection, another purpose, or a time outside the window', () => {
    const attestation = requireDefined(
      catalogSelectionValidityAttestationFor({
        evidence: validEvidence,
        purpose: 'PURCHASE_ACCEPTANCE',
        validUntil: '2026-09-18T13:00:00.000Z',
      }),
    );
    const otherSelection = decodeSelection({
      productRef,
      variantRef: ref('commerce.catalog.variant', '99999999-9999-4999-8999-999999999999'),
    });
    expect(catalogSelectionValidityCovers(attestation, { ...request, selection: otherSelection })).toBe(false);
    expect(catalogSelectionValidityCovers(attestation, { ...request, purpose: 'PRICING' })).toBe(false);
    expect(
      catalogSelectionValidityCovers(attestation, {
        ...request,
        at: decodeInstant('2026-09-18T11:59:59.000Z'),
      }),
    ).toBe(false);
    expect(
      catalogSelectionValidityCovers(attestation, {
        ...request,
        sourceToken: decodeBasis(
          basis.map((entry) =>
            entry.role === 'PRODUCT' ? { ...entry, source: { ...entry.source, revision: 2 } } : entry,
          ),
        ),
      }),
    ).toBe(false);
  });

  it('never mints a Current guarantee from indeterminate, mismatched, or expired input', () => {
    expect(
      catalogSelectionValidityAttestationFor({ evidence: indeterminateEvidence, purpose: 'PURCHASE_ACCEPTANCE' }),
    ).toBeUndefined();
    expect(
      catalogSelectionValidityAttestationFor({ evidence: validEvidence, purpose: 'PURCHASE_ACCEPTANCE' }),
    ).toBeUndefined();
    expect(() =>
      Schema.decodeUnknownSync(CatalogSelectionValidityAttestationSchema)({
        assessedAt: instant,
        basis,
        guarantee: 'EXACT_SELECTION_AND_CURRENT_BASIS_UNCHANGED',
        issuedAt: instant,
        onRetirement: 'INVALIDATE',
        onSourceChange: 'REASSESS',
        purpose: 'PURCHASE_ACCEPTANCE',
        selection,
        source: 'CATALOG_OWNER_CURRENT_READ',
      }),
    ).toThrow();
    expect(catalogSelectionValidityAttestationFor({ evidence: validEvidence, purpose: 'PRICING' })).toBeUndefined();
    expect(
      catalogSelectionValidityAttestationFor({
        evidence: validEvidence,
        purpose: 'PURCHASE_ACCEPTANCE',
        validUntil: instant,
      }),
    ).toBeUndefined();
    expect(() =>
      Schema.decodeUnknownSync(CatalogSelectionValidityAttestationSchema)({
        assessedAt: instant,
        basis,
        guarantee: 'EXACT_SELECTION_AND_CURRENT_BASIS_UNCHANGED',
        issuedAt: '2026-09-18T11:59:59.000Z',
        onRetirement: 'INVALIDATE',
        onSourceChange: 'REASSESS',
        purpose: 'PURCHASE_ACCEPTANCE',
        selection,
        source: 'CATALOG_OWNER_CURRENT_READ',
        validUntil: '2026-09-18T13:00:00.000Z',
      }),
    ).toThrow();
    for (const tamper of [
      { onRetirement: 'KEEP' },
      { onSourceChange: 'IGNORE' },
      { source: 'HISTORICAL_PROJECTION' },
      { guarantee: 'TIMESTAMP_ONLY' },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(CatalogSelectionValidityAttestationSchema)({
          assessedAt: instant,
          basis,
          guarantee: 'EXACT_SELECTION_AND_CURRENT_BASIS_UNCHANGED',
          issuedAt: instant,
          onRetirement: 'INVALIDATE',
          onSourceChange: 'REASSESS',
          purpose: 'PURCHASE_ACCEPTANCE',
          selection,
          source: 'CATALOG_OWNER_CURRENT_READ',
          validUntil: '2026-09-18T13:00:00.000Z',
          ...tamper,
        }),
      ).toThrow();
    }
  });
});
