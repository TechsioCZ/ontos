import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Cause, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import {
  CatalogToStockBindingRejected,
  CatalogToStockBindingSchema,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  mapCatalogToStockBindingWriteError,
  validateCatalogToStockBindingTarget,
} from '../../src/persistence/catalog-to-stock-binding-repository.ts';

const databaseFailure = (constraint: string, code = ['23', '505'].join('')) =>
  Cause.fail({
    _tag: 'SqlError',
    cause: { code, constraint },
    message: 'sanitized database failure',
  });

it.effect('maps only the two Current uniqueness constraints to typed relation conflicts', () =>
  Effect.gen(function* mapOwnedConstraints() {
    const selection = mapCatalogToStockBindingWriteError(
      databaseFailure('inventory_catalog_to_stock_bindings_selection_meaning_uk'),
    );
    const target = mapCatalogToStockBindingWriteError(
      databaseFailure('inventory_catalog_to_stock_bindings_stock_item_uk'),
    );
    const unrelated = mapCatalogToStockBindingWriteError(databaseFailure('inventory_some_other_constraint'));

    expect(Schema.is(CatalogToStockBindingRejected)(selection)).toBe(true);
    expect(selection.reason).toBe('SELECTION_MEANING_ALREADY_BOUND');
    expect(Schema.is(CatalogToStockBindingRejected)(target)).toBe(true);
    expect(target.reason).toBe('STOCK_ITEM_ALREADY_BOUND');
    expect(Schema.is(CatalogToStockBindingUnavailable)(unrelated)).toBe(true);
    expect(unrelated.code).toBe('catalog_to_stock_binding_unavailable');
    expect(Exit.isFailure(yield* Effect.exit(Effect.fail(unrelated)))).toBe(true);
  }),
);

it('maps database compatibility enforcement to the same typed binding outcomes', () => {
  const cases = [
    ['inventory_catalog_to_stock_bindings_target_missing_ck', 'STOCK_ITEM_NOT_FOUND'],
    ['inventory_catalog_to_stock_bindings_target_current_ck', 'STOCK_ITEM_NOT_CURRENT'],
    ['inventory_catalog_to_stock_bindings_target_meaning_ck', 'INTRINSIC_MEANING_MISMATCH'],
    ['inventory_catalog_to_stock_bindings_target_unit_ck', 'STOCK_UNIT_MISMATCH'],
  ] as const;

  for (const [constraint, reason] of cases) {
    const mapped = mapCatalogToStockBindingWriteError(databaseFailure(constraint, ['23', '514'].join('')));
    expect(Schema.is(CatalogToStockBindingRejected)(mapped)).toBe(true);
    expect(mapped.reason).toBe(reason);
  }
});

const tenantId = '11111111-1111-4111-8111-111111111111';
const stockItemId = '22222222-2222-4222-8222-222222222222';
const unitId = '33333333-3333-4333-8333-333333333333';
const meaning = { id: 'catalog-owner:meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const binding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  bindingRef: {
    moduleId: 'commerce.inventory',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  effectiveFrom: '2026-09-24T10:00:00.000Z',
  exactSelectionMeaning: meaning,
  revision: 1,
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: stockItemId,
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
  unitRef: {
    moduleId: 'commerce.catalog',
    resourceId: unitId,
    resourceType: 'commerce.catalog.product-unit',
    tenantId,
  },
});
const target = {
  createdAt: new Date('2026-09-24T09:00:00.000Z'),
  exactSelectionKind: meaning.kind,
  exactSelectionMeaningId: meaning.id,
  lifecycleState: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemId,
  stockUnitModuleId: binding.unitRef.moduleId,
  stockUnitResourceId: binding.unitRef.resourceId,
  stockUnitResourceType: binding.unitRef.resourceType,
  stockUnitTenantId: tenantId,
  tenantId,
};

it.effect(
  'validates the authoritative persisted Stock Item meaning, lifecycle, and Unit before writing a binding',
  () =>
    Effect.gen(function* validatePersistedTarget() {
      expect(yield* validateCatalogToStockBindingTarget(binding, target)).toEqual(binding);

      for (const [candidate, reason] of [
        [undefined, 'STOCK_ITEM_NOT_FOUND'],
        [{ ...target, lifecycleState: 'RETIRED' }, 'STOCK_ITEM_NOT_CURRENT'],
        [{ ...target, exactSelectionMeaningId: 'catalog-owner:other-meaning' }, 'INTRINSIC_MEANING_MISMATCH'],
        [{ ...target, stockUnitResourceId: '77777777-7777-4777-8777-777777777777' }, 'STOCK_UNIT_MISMATCH'],
      ] as const) {
        const failure = yield* validateCatalogToStockBindingTarget(binding, candidate).pipe(Effect.flip);
        expect(Schema.is(CatalogToStockBindingRejected)(failure)).toBe(true);
        expect(failure.reason).toBe(reason);
      }
    }),
);
