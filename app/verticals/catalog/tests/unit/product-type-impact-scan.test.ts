import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';

import type { productTypeAssignments } from '../../src/database/schema.ts';
import { productTypeRevisions, productTypes } from '../../src/database/schema.ts';

import {
  ProductTypeImpactScanIncomplete,
  productTypeImpactRevisionToken,
  productTypeImpactScanForScope,
  verifyProductTypeValueSetBasis,
} from '../../src/persistence/product-type-impact-scan.ts';

const basis = {
  candidateRules: [{ attributeDefinitionId: 'capacity', level: 'PRODUCT' as const, required: true }],
  evidence: [
    {
      assignmentRevision: 2,
      axisRevisions: [],
      productId: 'p1',
      productRevision: 3,
      valueSetRevisions: [
        {
          attributeDefinitionId: 'capacity',
          revision: 2,
          state: 'SET',
          valid: true,
          validitySourceRevisionToken: 'definition-3:value-2',
          variantId: null,
        },
      ],
      variantRevisions: [{ revision: 1, variantId: 'v1' }],
    },
  ],
  openSelectionRefs: [{ productId: 'p1', selectionId: 's1', variantId: 'v1' }],
  preview: { affectedProductIds: ['p1'], requiresExplicitRemediation: true, subjects: [] },
  productTypeId: 't1',
  selectionRevisionToken: 'selection-current-1',
  sourceRevision: 4,
  sourceRevisionId: 'r4',
  tenantId: 'tenant-1',
};

type ImpactTable = typeof productTypes | typeof productTypeRevisions | typeof productTypeAssignments;
const mockRows = (table: ImpactTable) => {
  if (table === productTypes) {
    return [{ revision: 1 }];
  }
  if (table === productTypeRevisions) {
    return [{ id: 'revision-1' }];
  }
  return [];
};
const mockFrom = (table: ImpactTable) => ({
  where: () => {
    const effect = Effect.succeed(mockRows(table));
    return Object.assign(effect, { for: () => ({ limit: () => effect }), limit: () => effect });
  },
});
const emptyPopulationTransaction = { select: () => ({ from: mockFrom }) };
const catalogTenantId = '11111111-1111-4111-8111-111111111111';
const emptyOpenSelectionPort = {
  read: () =>
    Effect.succeed({
      complete: true as const,
      observedAt: '2026-09-18T12:00:00.000Z',
      revisionToken: 'selection-empty-1',
      selections: [],
      tenantId: catalogTenantId,
    }),
};

const unrelatedSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.catalog.product',
    tenantId: catalogTenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.variant',
    tenantId: catalogTenantId,
  },
});

describe('Product Type impact scan basis', () => {
  it('binds direct Product, Variant, and open selection revisions deterministically', () => {
    const token = productTypeImpactRevisionToken(basis);
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(productTypeImpactRevisionToken(basis)).toBe(token);
    const [firstEvidence] = basis.evidence;
    if (firstEvidence === undefined) {
      throw new Error('Test fixture requires evidence');
    }
    expect(productTypeImpactRevisionToken({ ...basis, evidence: [{ ...firstEvidence, productRevision: 4 }] })).not.toBe(
      token,
    );
    expect(productTypeImpactRevisionToken({ ...basis, selectionRevisionToken: 'selection-current-2' })).not.toBe(token);
    expect(productTypeImpactRevisionToken({ ...basis, tenantId: 'tenant-2' })).not.toBe(token);
    const [set] = firstEvidence.valueSetRevisions;
    if (set === undefined) {
      throw new Error('Test fixture requires a value set');
    }
    for (const changed of [
      { ...set, valid: false },
      { ...set, validitySourceRevisionToken: 'definition-4:value-2' },
      { ...set, revision: 3 },
      { ...set, variantId: 'v1' },
    ]) {
      expect(
        productTypeImpactRevisionToken({
          ...basis,
          evidence: [{ ...firstEvidence, valueSetRevisions: [changed] }],
        }),
      ).not.toBe(token);
    }
  });

  it('declares unknown #479 evidence as a typed incomplete outcome', () => {
    const failure = new ProductTypeImpactScanIncomplete({
      code: 'product_type_impact_scan_incomplete',
      reason: 'Open Catalog Selection population is unknown',
    });
    expect(Schema.is(ProductTypeImpactScanIncomplete)(failure)).toBe(true);
  });

  it.effect('fails closed when no owner-confirmed #479 open-selection evidence is injected', () =>
    Effect.gen(function* missingOpenSelectionEvidence() {
      const scope = { tenantId: catalogTenantId };
      // @ts-expect-error The mock provides only the queried scoped transaction methods.
      const scan = productTypeImpactScanForScope(emptyPopulationTransaction, scope);
      const failure = yield* Effect.flip(
        scan.scan({ candidateRules: [], expectedCurrentRevision: 1, productTypeId: 'type-1' }),
      );
      expect(failure).toBeInstanceOf(ProductTypeImpactScanIncomplete);
      expect(failure.code).toBe('product_type_impact_scan_incomplete');
      expect(failure.reason).toContain('open-selection');
    }),
  );

  it.effect('fails closed when a Variant may inherit a changed Product-level requirement', () =>
    Effect.gen(function* unprovenInheritance() {
      const scope = { tenantId: catalogTenantId };
      // @ts-expect-error The mock provides only the queried scoped transaction methods.
      const scan = productTypeImpactScanForScope(emptyPopulationTransaction, scope, {
        openSelections: emptyOpenSelectionPort,
      });
      const failure = yield* Effect.flip(
        scan.scan({
          candidateRules: [
            { attributeDefinitionId: 'capacity', level: 'PRODUCT', required: true },
            { attributeDefinitionId: 'capacity', level: 'VARIANT', required: true },
          ],
          expectedCurrentRevision: 1,
          productTypeId: 'type-1',
        }),
      );
      expect(failure).toBeInstanceOf(ProductTypeImpactScanIncomplete);
      expect(failure.reason).toContain('inheritance');
    }),
  );

  it('accepts only a complete exact owner value-set basis', () => {
    const set = {
      attributeDefinitionId: 'capacity',
      attributeValueSetId: 'set-1',
      currentRevision: 2,
      currentState: 'SET',
      productId: 'p1',
      tenantId: 'tenant-1',
      variantId: null,
    };
    const entry = {
      attributeDefinitionId: 'capacity',
      attributeValueSetId: 'set-1',
      confirmsRequiredFact: true,
      currentState: 'SET' as const,
      definitionRevision: 3,
      productId: 'p1',
      revision: 2,
      sourceRevisionToken: 'definition-3:value-2',
      valid: true,
      variantId: null,
    };
    const proof = { complete: true, entries: [entry], tenantId: 'tenant-1' };
    expect(verifyProductTypeValueSetBasis([set], proof, 'tenant-1')?.validity.get('set-1')).toBe(true);
    expect(verifyProductTypeValueSetBasis([set], { ...proof, complete: false }, 'tenant-1')).toBeNull();
    expect(verifyProductTypeValueSetBasis([set], { ...proof, entries: [] }, 'tenant-1')).toBeNull();
    expect(
      verifyProductTypeValueSetBasis([set], { ...proof, entries: [{ ...entry, currentState: 'REMOVED' }] }, 'tenant-1'),
    ).toBeNull();
    expect(
      verifyProductTypeValueSetBasis([set], { ...proof, entries: [{ ...entry, definitionRevision: 0 }] }, 'tenant-1'),
    ).toBeNull();
  });

  it.effect('obtains an empty complete value inventory from the owner reader in the same transaction', () =>
    Effect.gen(function* emptyPopulation() {
      const scope = { tenantId: catalogTenantId };
      // @ts-expect-error The mock provides only the queried scoped transaction methods.
      const scan = productTypeImpactScanForScope(emptyPopulationTransaction, scope, {
        openSelections: emptyOpenSelectionPort,
      });
      const result = yield* scan.scan({ candidateRules: [], expectedCurrentRevision: 1, productTypeId: 'type-1' });
      expect(result.preview).toEqual({ affectedProductIds: [], requiresExplicitRemediation: false, subjects: [] });
      expect(result.token).toMatch(/^[0-9a-f]{64}$/u);
    }),
  );

  it.effect('ignores tenant Cart selections for Products outside the revised Product Type population', () =>
    Effect.gen(function* unrelatedCartSelection() {
      const scope = { tenantId: catalogTenantId };
      const openSelections = {
        read: () =>
          Effect.succeed({
            complete: true as const,
            observedAt: '2026-09-18T12:00:00.000Z',
            revisionToken: 'selection-with-unrelated-product',
            selections: [{ selection: unrelatedSelection, selectionId: 'unrelated-selection' }],
            tenantId: catalogTenantId,
          }),
      };
      // @ts-expect-error The mock provides only the queried scoped transaction methods.
      const scan = productTypeImpactScanForScope(emptyPopulationTransaction, scope, { openSelections });
      const result = yield* scan.scan({ candidateRules: [], expectedCurrentRevision: 1, productTypeId: 'type-1' });
      expect(result.openSelectionRefs).toEqual([]);
      expect(result.token).toMatch(/^[0-9a-f]{64}$/u);
    }),
  );
});
