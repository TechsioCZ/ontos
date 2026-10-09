import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogQuantityHandoffSchema } from '../../shared/domain/catalog-quantity-handoff.ts';
import type { CatalogQuantityHandoffBasisFacts } from '../../shared/domain/catalog-quantity-handoff.ts';
import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import type { CatalogResourceRef } from '../../shared/domain/catalog-revision-reference.ts';
import type { CatalogSelectionCurrentFacts } from '../../shared/domain/catalog-selection-assessment.ts';
import {
  CatalogSelectionBasisSchema,
  CatalogSelectionMembershipSchema,
  CatalogSelectionRevisionSchema,
  CatalogSelectionSchema,
  PackageDefinitionSelectionRevisionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import type { PackageContentRevision, PackageResolution } from '../../shared/domain/package-content.ts';
import type { QuantityNormalization } from '../../shared/domain/purchase-quantity.ts';
import { catalogQuantityHandoffWith } from '../../src/persistence/catalog-quantity-handoff.ts';
import type { CatalogQuantityHandoffReaders } from '../../src/persistence/catalog-quantity-handoff.ts';
import type { CatalogQuantityPreparation } from '../../src/persistence/catalog-quantity-preparation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const packageId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const ref = (resourceType: string, resourceId: string) =>
  Schema.decodeUnknownSync(CatalogResourceRefSchema)({
    moduleId: 'commerce.catalog',
    resourceId,
    resourceType,
    tenantId,
  });
const packageRef = ref('commerce.catalog.package-definition', packageId);
const unitRef = ref('commerce.catalog.product-unit', unitId);
const productTypeRef = ref('commerce.catalog.product-type', '66666666-6666-4666-8666-666666666666');
const pinned = Schema.decodeUnknownSync(PackageDefinitionSelectionRevisionSchema)({
  resourceRef: packageRef,
  revision: 1,
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageOption: { contentRevision: pinned, optionRef: packageRef },
  productRef: ref('commerce.catalog.product', productId),
  variantRef: ref('commerce.catalog.variant', variantId),
});
const sourceRevision = (resourceRef: CatalogResourceRef, revision: number) =>
  Schema.decodeUnknownSync(CatalogSelectionRevisionSchema)({ resourceRef, revision });
const basisEntry = Schema.decodeUnknownSync(CatalogSelectionBasisSchema);
const currentBasis = [
  basisEntry({ role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 2 } }),
  basisEntry({ role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 3 } }),
  basisEntry({ role: 'PRODUCT_TYPE', source: { resourceRef: productTypeRef, revision: 1 } }),
  basisEntry({ role: 'PACKAGE_CONTENT', source: pinned }),
  basisEntry({ role: 'UNIT_RULE', source: { resourceRef: unitRef, revision: 1 } }),
  basisEntry({ role: 'UNIT_TARGET_DIVISIBILITY', source: { resourceRef: packageRef, revision: 1 } }),
];
const current: CatalogSelectionCurrentFacts = {
  assessedAt: '2026-09-17T12:00:00.000Z',
  basis: currentBasis,
  dependentFactsComplete: true,
  membership: Schema.decodeUnknownSync(CatalogSelectionMembershipSchema)({
    attestationId: '99999999-9999-4999-8999-999999999999',
    observedAt: '2026-09-17T12:00:00.000Z',
    productRef: selection.productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: { resourceRef: selection.variantRef, revision: 3 },
  }),
  productLifecycle: 'ACTIVE',
  purpose: 'purchase',
  selection,
  source: 'CATALOG_OWNER_CURRENT_READ',
  status: 'OBSERVED',
  variantLifecycle: 'ACTIVE',
};
const quantity: Extract<QuantityNormalization, { status: 'VALID' }> = {
  changed: false,
  notice: null,
  requested: '2',
  resulting: '2',
  rounding: 'UP',
  status: 'VALID',
  step: '1',
  targetId: packageId,
  tenantId,
  unitId,
  unitRuleRevision: 1,
};
const preparation: Extract<CatalogQuantityPreparation, { status: 'PREPARED' }> = {
  divisible: false,
  quantity,
  selection,
  sources: {
    packageDefinition: sourceRevision(packageRef, 1),
    product: sourceRevision(selection.productRef, 2),
    targetDivisibilityRevision: 1,
    unitRuleRevision: 1,
    variant: sourceRevision(selection.variantRef, 3),
  },
  status: 'PREPARED',
  unitRef,
};
const basisFacts: CatalogQuantityHandoffBasisFacts & { readonly status: 'CURRENT' } = {
  contentPath: [
    { amount: '10', configurationKey: null, lowerCount: null, packageDefinitionId: packageId, revision: 1, unitId },
  ],
  productRevision: 2,
  status: 'CURRENT',
  unit: {
    divisible: false,
    id: unitId,
    rounding: 'UP',
    ruleRevision: 1,
    step: '1',
    targetDivisibilityRevision: 1,
  },
  variantRevision: 3,
};
const request = { amount: '2', purpose: 'purchase', selection } as const;

const readers = (overrides: Partial<CatalogQuantityHandoffReaders> = {}): CatalogQuantityHandoffReaders => ({
  prepareQuantity: () => Effect.succeed(preparation),
  readCurrent: () => Effect.succeed(current),
  readPackageUnitBasis: () => Effect.succeed(basisFacts),
  ...overrides,
});

const preparedQuantity = (
  changes: Partial<Extract<QuantityNormalization, { status: 'VALID' }>>,
): Extract<CatalogQuantityPreparation, { status: 'PREPARED' }> => ({
  ...preparation,
  quantity: { ...quantity, ...changes },
});

describe('Catalog quantity handoff seam', () => {
  it.effect('provides the same exact revisioned facts for any customer without a commercial verdict', () =>
    Effect.gen(function* providesExactFacts() {
      const result = yield* catalogQuantityHandoffWith(readers()).prepare(request);
      expect(result.status).toBe('READY');
      if (result.status !== 'READY') {
        return;
      }
      const { packageContent, packageRevision } = result;
      const content: PackageContentRevision | undefined = packageRevision;
      const resolution: PackageResolution | undefined = packageContent;
      expect(result.quantity.resulting).toBe('2');
      expect(result.quantityBasis).toEqual({
        targetDivisibilityRevision: 1,
        targetRef: packageRef,
        unitRef,
        unitRuleRevision: 1,
      });
      expect(result.ownerRevision).toMatch(/^commerce\.catalog\.quantity:/u);
      expect(result.hierarchyRevision).toMatch(/^commerce\.catalog\.hierarchy:/u);
      expect(result.equivalentSelectionKey).toMatch(/^commerce\.catalog\.selection:/u);
      expect(result.completeness).toEqual({
        observedAt: current.assessedAt,
        ownerRevision: result.ownerRevision,
        scope: {
          kind: 'EXACT_PREDICATE',
          predicateRef: `commerce.catalog.quantity-preparation:${result.equivalentSelectionKey}:purchase:2`,
        },
      });
      expect(content?.amount).toBe('10');
      expect(content?.reference).toEqual(pinned);
      expect(resolution?.amount).toBe('20');
      const keys = Object.keys(result);
      for (const key of [
        'divisible',
        'completeness',
        'evidence',
        'equivalentSelectionKey',
        'hierarchyRevision',
        'ownerRevision',
        'packageContent',
        'packageRevision',
        'quantity',
        'quantityBasis',
        'selection',
        'status',
        'unitRef',
      ]) {
        expect(keys).toContain(key);
      }
      expect(keys).toHaveLength(13);
      expect(() => Schema.encodeSync(CatalogQuantityHandoffSchema)(result)).not.toThrow();
      expect(JSON.stringify(result)).not.toMatch(/allowed|denied|minimum|multiple|customer/iu);
    }),
  );

  it.effect('never estimates missing Package Content as a default package size', () =>
    Effect.gen(function* missingContentIsNotEstimated() {
      const result = yield* catalogQuantityHandoffWith(
        readers({
          readPackageUnitBasis: () =>
            Effect.succeed({ reason: 'Exact Package Content owner proof is missing', status: 'INDETERMINATE' }),
        }),
      ).prepare(request);
      expect(result.status).toBe('UNVERIFIABLE');
      expect('packageContent' in result).toBe(false);
      expect('quantity' in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain('10');
    }),
  );

  it.effect('forces new matching facts after a box changes from ten to eight', () =>
    Effect.gen(function* changedBoxForcesNewFacts() {
      const result = yield* catalogQuantityHandoffWith(
        readers({
          readPackageUnitBasis: () =>
            Effect.succeed({
              ...basisFacts,
              contentPath: [
                {
                  amount: '8',
                  configurationKey: null,
                  lowerCount: null,
                  packageDefinitionId: packageId,
                  revision: 2,
                  unitId,
                },
              ],
            }),
        }),
      ).prepare(request);
      expect(result.status).toBe('STALE');
      expect('packageContent' in result).toBe(false);
    }),
  );

  it.effect('keeps disclosed normalization distinct from any commercial rejection', () =>
    Effect.gen(function* disclosedNormalization() {
      const result = yield* catalogQuantityHandoffWith(
        readers({
          prepareQuantity: () =>
            Effect.succeed(preparedQuantity({ changed: true, notice: 'ROUNDED', requested: '2.5', resulting: '3' })),
        }),
      ).prepare(request);
      expect(result.status).toBe('READY');
      if (result.status !== 'READY') {
        return;
      }
      expect(result.quantity).toMatchObject({ changed: true, notice: 'ROUNDED', requested: '2.5', resulting: '3' });
      expect(JSON.stringify(result)).not.toMatch(/reject|denied|forbidden/iu);
    }),
  );

  it.effect('fails closed on unavailable Current evidence before reading a deciding basis', () =>
    Effect.gen(function* failsClosedBeforeBasis() {
      let basisReads = 0;
      const unavailable: CatalogSelectionCurrentFacts = {
        assessedAt: current.assessedAt,
        basis: [],
        purpose: current.purpose,
        reason: 'Current Product and Variant membership is not owner-attested',
        selection,
        source: 'CATALOG_OWNER_CURRENT_READ',
        status: 'INDETERMINATE',
      };
      const result = yield* catalogQuantityHandoffWith(
        readers({
          readCurrent: () => Effect.succeed(unavailable),
          readPackageUnitBasis: () => {
            basisReads += 1;
            return Effect.succeed(basisFacts);
          },
        }),
      ).prepare(request);
      expect(result.status).toBe('UNVERIFIABLE');
      if (result.status === 'UNVERIFIABLE') {
        expect(result.reason).toBe('Current Product and Variant membership is not owner-attested');
      }
      expect(basisReads).toBe(0);
    }),
  );

  it.effect('fails closed when the prepared divisibility basis is no longer the evidenced one', () =>
    Effect.gen(function* staleDivisibilityBasis() {
      const result = yield* catalogQuantityHandoffWith(
        readers({
          readPackageUnitBasis: () =>
            Effect.succeed({ ...basisFacts, unit: { ...basisFacts.unit, targetDivisibilityRevision: 2 } }),
        }),
      ).prepare(request);
      expect(result.status).toBe('STALE');
      if (result.status === 'STALE') {
        expect(result.reason).toMatch(/do not match the exact Current basis/iu);
      }
    }),
  );

  it.effect('preserves the exact Set Composition Revision on a packaged Set', () =>
    Effect.gen(function* preservesSetComposition() {
      const setComposition = {
        resourceRef: ref('commerce.catalog.set-composition', '77777777-7777-4777-8777-777777777777'),
        revision: 1,
      };
      const setSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ ...selection, setComposition });
      const setCurrent: CatalogSelectionCurrentFacts = {
        ...current,
        basis: [...currentBasis, basisEntry({ role: 'SET_COMPOSITION', source: setComposition })],
        selection: setSelection,
      };
      const setPreparation: Extract<CatalogQuantityPreparation, { status: 'PREPARED' }> = {
        ...preparation,
        selection: setSelection,
      };
      const result = yield* catalogQuantityHandoffWith(
        readers({
          prepareQuantity: () => Effect.succeed(setPreparation),
          readCurrent: () => Effect.succeed(setCurrent),
        }),
      ).prepare({ ...request, selection: setSelection });
      expect(result.status).toBe('READY');
      if (result.status === 'READY') {
        expect(result.packageRevision?.setComposition).toEqual(setComposition);
      }
    }),
  );
});
