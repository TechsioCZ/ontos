import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  VariantUseChangeBasisUnavailable,
  variantUseChangePersistenceForAxes,
} from '../../src/persistence/variant-use-change-persistence.ts';
import type {
  VariantReactivationBasis,
  VariantReactivationBasisPersistence,
  VariantReactivationSelectionAuthority,
} from '../../src/persistence/variant-use-change-persistence.ts';
import type { CartOpenSelectionPopulationEvidence } from '../../shared/domain/catalog-open-selection-population.ts';
import {
  CartOpenSelectionPopulationEvidenceSchema,
  CartOpenSelectionPopulationUnavailable,
} from '../../shared/domain/catalog-open-selection-population.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type {
  CurrentVariantAxes,
  CurrentVariantAxisValue,
  VariantAxisPersistence,
} from '../../src/persistence/variant-axis-persistence.ts';
import {
  effectiveValueItemKeyHash,
  recordedVariantCombinationKey,
  VariantAxisBasisUnavailable,
} from '../../src/persistence/variant-axis-persistence.ts';
import { VariantUseChangeConflict } from '../../shared/domain/variant-use-change.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const otherVariantId = '44444444-4444-4444-8444-444444444444';
const definitionId = '55555555-5555-4555-8555-555555555555';
const valueSetId = '66666666-6666-4666-8666-666666666666';
const axes: CurrentVariantAxes = {
  axes: [
    {
      attributeDefinitionId: definitionId,
      controlledValueKind: 'COLOR',
      definitionRevision: 3,
      inheritable: false,
      multiplicity: 'SINGLE',
      ordinal: 0,
      valueKind: 'CONTROLLED',
    },
  ],
  axisRevision: 1,
  productId: productRef.resourceId,
  productTypeRevision: 2,
};
const item = {
  attributeDefinitionId: definitionId,
  attributeValueSetId: valueSetId,
  controlledAttributeValueId: '77777777-7777-4777-8777-777777777777',
  numericValue: null,
  ordinal: 0,
  specialState: null,
  tenantId,
  textValue: null,
  unit: null,
  valueKind: 'CONTROLLED',
};
const value: CurrentVariantAxisValue = {
  attributeDefinitionId: definitionId,
  definitionRevision: 3,
  items: [item],
  source: 'VARIANT',
  sourceRevision: 5,
  sourceValueSetRef: { attributeValueSetId: valueSetId, tenantId },
};
const reactivationKey = recordedVariantCombinationKey([value], tenantId);
const allowedValues = {
  allowanceRevision: 1,
  attributeDefinitionId: definitionId,
  definitionRevision: 3,
  valueKeys: [effectiveValueItemKeyHash(item)],
};
const unexpected = () => Effect.die('Unexpected axis read');
const basis = (overrides: Partial<VariantReactivationBasis> = {}): VariantReactivationBasisPersistence => ({
  read: () => Effect.succeed({ parentProductLifecycle: 'ACTIVE', requiredPackageOptions: [], ...overrides }),
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const decodePopulation = Schema.decodeUnknownSync(CartOpenSelectionPopulationEvidenceSchema);
const populationWith = (revisionToken: string, selectionIds: readonly string[]): CartOpenSelectionPopulationEvidence =>
  decodePopulation({
    complete: true,
    observedAt: '2026-09-18T12:00:00.000Z',
    revisionToken,
    selections: selectionIds.map((selectionId) => ({ selection, selectionId })),
    tenantId,
  });
const emptyPopulation = populationWith('cart-population-1', []);
const authority = (population: CartOpenSelectionPopulationEvidence): VariantReactivationSelectionAuthority => ({
  evidence: { assess: () => Effect.succeed({ evidence: { kind: 'NOT_FOUND', requested: selection } }) },
  openSelections: { read: () => Effect.succeed(population) },
});
const persistence = (
  overrides: Partial<VariantAxisPersistence>,
  basisOverrides: Partial<VariantReactivationBasis> = {},
  selectionAuthority: VariantReactivationSelectionAuthority = authority(emptyPopulation),
) => {
  const service: VariantAxisPersistence = {
    govern: unexpected,
    governAllowedValues: unexpected,
    readCurrent: () => Effect.succeed(axes),
    readCurrentAllowedValues: () => Effect.succeed([allowedValues]),
    readEffectiveValues: () => Effect.succeed([value]),
    readRecordedCombinations: () =>
      Effect.succeed([{ axisRevision: 1, combinationKey: 'a'.repeat(64), variantId: otherVariantId }]),
    readRecordedVariants: unexpected,
    ...overrides,
  };
  return variantUseChangePersistenceForAxes(service, basis(basisOverrides), tenantId, selectionAuthority);
};

describe('Variant use change persistence (#441)', () => {
  it.effect('reports a definite conflict when reactivation reproduces an ACTIVE combination', () =>
    Effect.gen(function* collision() {
      const failure = yield* persistence({
        readRecordedCombinations: () =>
          Effect.succeed([{ axisRevision: 1, combinationKey: reactivationKey, variantId: otherVariantId }]),
      })
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'DUPLICATE_COMBINATION' });
    }),
  );

  it.effect('proves a collision-free reactivation against a complete Cart population and Catalog evidence', () =>
    Effect.gen(function* clean() {
      const assessment = yield* persistence({}).assessReactivation({ productRef, variantRef });
      expect(assessment).toEqual({
        combinationAxisRevision: 1,
        combinationKey: reactivationKey,
        decision: { changeKind: 'CORRECTED', revalidation: 'NOT_REQUIRED' },
      });
    }),
  );

  it.effect('rejects a value retired from the Current Product-specific allowed set', () =>
    Effect.gen(function* impermissible() {
      const retiredHash = effectiveValueItemKeyHash({
        ...item,
        controlledAttributeValueId: '88888888-8888-4888-8888-888888888888',
      });
      const failure = yield* persistence({
        readCurrentAllowedValues: () => Effect.succeed([{ ...allowedValues, valueKeys: [retiredHash] }]),
      })
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'INVALID_VALUE' });
    }),
  );

  it.effect('fails closed when the Current Product-specific allowed set cannot be verified', () =>
    Effect.gen(function* allowedUnavailable() {
      const failure = yield* persistence({
        readCurrentAllowedValues: () =>
          Effect.fail(
            new VariantAxisBasisUnavailable({ code: 'variant_axis_basis_unavailable', reason: 'allowance missing' }),
          ),
      })
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeBasisUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('fails closed without the Cart open-selection owner contract', () =>
    Effect.gen(function* noAuthority() {
      const service: VariantAxisPersistence = {
        govern: unexpected,
        governAllowedValues: unexpected,
        readCurrent: () => Effect.succeed(axes),
        readCurrentAllowedValues: () => Effect.succeed([allowedValues]),
        readEffectiveValues: () => Effect.succeed([value]),
        readRecordedCombinations: () =>
          Effect.succeed([{ axisRevision: 1, combinationKey: 'a'.repeat(64), variantId: otherVariantId }]),
        readRecordedVariants: unexpected,
      };
      const failure = yield* variantUseChangePersistenceForAxes(service, basis(), tenantId)
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeBasisUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('blocks reactivation while an open Cart selection still references the Variant', () =>
    Effect.gen(function* openSelection() {
      const failure = yield* persistence({}, {}, authority(populationWith('cart-population-2', ['cart-selection-1'])))
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'OPEN_SELECTION_REVALIDATION_REQUIRED' });
    }),
  );

  it.effect('fails closed when the injected Cart population read is unavailable', () =>
    Effect.gen(function* unavailablePopulation() {
      const failure = yield* persistence(
        {},
        {},
        {
          evidence: { assess: () => Effect.succeed({ evidence: { kind: 'NOT_FOUND', requested: selection } }) },
          openSelections: {
            read: () =>
              Effect.fail(
                new CartOpenSelectionPopulationUnavailable({
                  code: 'cart_open_selection_population_unavailable',
                  reason: 'Cart is unavailable',
                }),
              ),
          },
        },
      )
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeBasisUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('blocks a retired parent Product before looking for a Current collision', () =>
    Effect.gen(function* retiredParent() {
      const failure = yield* persistence({}, { parentProductLifecycle: 'RETIRED' })
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'RETIRED_PARENT_PRODUCT' });
    }),
  );

  it.effect('blocks reactivation while a required Package Option is retired or inactive', () =>
    Effect.gen(function* retiredPackageOption() {
      const failure = yield* persistence({}, { requiredPackageOptions: [{ lifecycle: 'RETIRED' }] })
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'RETIRED_PACKAGE_OPTION' });
    }),
  );

  it.effect('fails closed when the owner-issued reactivation lifecycle basis is unavailable', () =>
    Effect.gen(function* unavailableReactivationBasis() {
      const failure = yield* variantUseChangePersistenceForAxes(
        {
          govern: unexpected,
          governAllowedValues: unexpected,
          readCurrent: () => Effect.succeed(axes),
          readCurrentAllowedValues: unexpected,
          readEffectiveValues: () => Effect.succeed([value]),
          readRecordedCombinations: () =>
            Effect.succeed([{ axisRevision: 1, combinationKey: 'a'.repeat(64), variantId: otherVariantId }]),
          readRecordedVariants: unexpected,
        },
        {
          read: () =>
            Effect.fail(
              new VariantUseChangeBasisUnavailable({ code: 'variant_use_change_basis_unavailable', reason: 'missing' }),
            ),
        },
        tenantId,
      )
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeBasisUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('fails closed when the retired Variant no longer carries a documented value', () =>
    Effect.gen(function* missingValue() {
      const failure = yield* persistence({
        readEffectiveValues: () =>
          Effect.succeed([{ ...value, items: [], source: 'MISSING' as const, sourceRevision: null }]),
      })
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeBasisUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('maps an unavailable Current axis basis to a typed basis failure', () =>
    Effect.gen(function* unavailableBasis() {
      const failure = yield* persistence({
        readCurrent: () =>
          Effect.fail(
            new VariantAxisBasisUnavailable({
              code: 'variant_axis_basis_unavailable',
              reason: 'stale',
            }),
          ),
      })
        .assessReactivation({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeBasisUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('rejects a foreign tenant before reading private data', () =>
    Effect.gen(function* foreignTenant() {
      const failure = yield* persistence({
        readCurrent: () => Effect.die('foreign tenant must not read'),
      })
        .assessReactivation({
          productRef: { ...productRef, tenantId: '99999999-9999-4999-8999-999999999999' },
          variantRef,
        })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeBasisUnavailable)(failure)).toBe(true);
    }),
  );
});
