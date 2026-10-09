import {
  CatalogSelectionSchema,
  ProductConfigurationSelectionSchema,
} from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CatalogStockDemandSchema,
  CatalogToStockBindingSchema,
  makeCatalogToStockBindingResolver,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  ConfigurationStockItemBindingRejected,
  preserveConfigurationStockDemand,
} from '../../shared/domain/configuration-stock-item-binding.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import type { StockItem } from '../../shared/domain/stock-item.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-09-24T12:00:00.000Z';

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
const pieceUnitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const millimeterUnitRef = {
  ...pieceUnitRef,
  resourceId: '55555555-5555-4555-8555-555555555555',
} as const;

const configuredSelection = (input: {
  readonly configurationUnitId?: string;
  readonly definitionRevision?: number;
  readonly length?: string;
  readonly variantId?: string;
}) => {
  const targetVariantRef = { ...variantRef, resourceId: input.variantId ?? variantRef.resourceId };
  return Schema.decodeUnknownSync(CatalogSelectionSchema)({
    configuration: {
      choices: [
        {
          choiceKey: 'length',
          unit: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: input.configurationUnitId ?? '66666666-6666-4666-8666-666666666666',
              resourceType: 'commerce.catalog.unit',
              tenantId,
            },
            revision: 1,
          },
          value: input.length ?? '500',
        },
      ],
      definition: {
        resourceRef: {
          moduleId: 'commerce.catalog',
          resourceId: '77777777-7777-4777-8777-777777777777',
          resourceType: 'commerce.catalog.configuration-definition',
          tenantId,
        },
        revision: input.definitionRevision ?? 1,
      },
      productRef,
      variantRef: targetVariantRef,
    },
    productRef,
    variantRef: targetVariantRef,
  });
};

const exactMeaning = (id: string) => ({ id, kind: 'CONFIGURED_SELECTION' as const });

const stockItem = (input: {
  readonly exactSelectionMeaning: ReturnType<typeof exactMeaning>;
  readonly id: string;
  readonly unitRef: StockItem['unitRef'];
}) =>
  Schema.decodeUnknownSync(StockItemSchema)({
    createdAt: timestamp,
    exactSelectionMeaning: input.exactSelectionMeaning,
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: input.id,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    unitRef: input.unitRef,
  });

const binding = (input: {
  readonly catalogSelection: ReturnType<typeof configuredSelection>;
  readonly exactSelectionMeaning: ReturnType<typeof exactMeaning>;
  readonly id: string;
  readonly stockItem: ReturnType<typeof stockItem>;
}) =>
  Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
    bindingRef: {
      moduleId: 'commerce.inventory',
      resourceId: input.id,
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId,
    },
    catalogSelection: input.catalogSelection,
    effectiveFrom: timestamp,
    exactSelectionMeaning: input.exactSelectionMeaning,
    revision: 1,
    stockItemRef: input.stockItem.stockItemRef,
    unitRef: input.stockItem.unitRef,
  });

const demand = (input: {
  readonly catalogSelection: ReturnType<typeof configuredSelection>;
  readonly exactSelectionMeaning: ReturnType<typeof exactMeaning>;
  readonly occurrence: string;
  readonly quantity: string;
  readonly unitRef: StockItem['unitRef'];
}) => {
  const decoded = Schema.decodeUnknownSync(CatalogStockDemandSchema)({
    catalogSelection: input.catalogSelection,
    exactSelectionMeaning: input.exactSelectionMeaning,
    purchaseDemandOccurrenceId: input.occurrence,
    quantity: input.quantity,
    unitRef: input.unitRef,
  });
  return {
    ...decoded,
    catalogSelection: {
      ...decoded.catalogSelection,
      configuration: Schema.decodeUnknownSync(ProductConfigurationSelectionSchema)(
        decoded.catalogSelection.configuration,
      ),
    },
  };
};

const resolverFor = (
  currentBindings: readonly ReturnType<typeof binding>[],
  items: readonly ReturnType<typeof stockItem>[],
) => {
  const canonicalResolver = makeCatalogToStockBindingResolver(
    {
      findCurrentByExactSelectionMeaning: (_tenantId, meaning) =>
        Effect.succeed(currentBindings.filter((candidate) => candidate.exactSelectionMeaning.id === meaning.id)),
    },
    {
      findById: (_tenantId, id) => {
        const item = items.find((candidate) => candidate.stockItemRef.resourceId === id);
        return item === undefined ? Effect.succeedNone : Effect.succeed(Option.some(item));
      },
    },
  );
  return {
    resolve: (configuredDemand: ReturnType<typeof demand>) =>
      canonicalResolver.resolve(configuredDemand).pipe(
        Effect.flatMap((resolved) => {
          const selectedBinding = currentBindings.find(
            (candidate) => candidate.bindingRef.resourceId === resolved.bindingRef.resourceId,
          );
          return selectedBinding === undefined
            ? Effect.die(new Error('Canonical resolver returned an unknown binding in the test fixture'))
            : preserveConfigurationStockDemand(configuredDemand, resolved, selectedBinding);
        }),
      ),
  };
};

describe('Configuration Stock Item Binding', () => {
  it.effect('keeps a 500 mm configured attribute separate from a request for 2 pieces', () =>
    Effect.gen(function* preservePieceQuantity() {
      const selection = configuredSelection({ length: '500' });
      const meaning = exactMeaning('catalog-owner:configured-500-mm-piece');
      const item = stockItem({
        exactSelectionMeaning: meaning,
        id: '88888888-8888-4888-8888-888888888888',
        unitRef: pieceUnitRef,
      });
      const currentBinding = binding({
        catalogSelection: selection,
        exactSelectionMeaning: meaning,
        id: '99999999-9999-4999-8999-999999999999',
        stockItem: item,
      });
      const requested = demand({
        catalogSelection: selection,
        exactSelectionMeaning: meaning,
        occurrence: 'purchase-demand-configured-piece',
        quantity: '2',
        unitRef: pieceUnitRef,
      });

      const resolved = yield* resolverFor([currentBinding], [item]).resolve(requested);

      expect(resolved.quantity).toBe('2');
      expect(resolved.unitRef).toEqual(pieceUnitRef);
      expect(resolved.catalogSelection.configuration?.choices[0]?.value).toBe('500');
      expect(resolved).not.toHaveProperty('convertedQuantity');
      expect(resolved).not.toHaveProperty('componentDemand');
    }),
  );

  it.effect('keeps 830 millimeters unchanged when millimeter is the Stock Item Unit', () =>
    Effect.gen(function* preserveMeasuredUnitQuantity() {
      const selection = configuredSelection({ length: '830' });
      const meaning = exactMeaning('catalog-owner:configured-measured-length');
      const item = stockItem({
        exactSelectionMeaning: meaning,
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        unitRef: millimeterUnitRef,
      });
      const currentBinding = binding({
        catalogSelection: selection,
        exactSelectionMeaning: meaning,
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        stockItem: item,
      });
      const requested = demand({
        catalogSelection: selection,
        exactSelectionMeaning: meaning,
        occurrence: 'purchase-demand-configured-millimeters',
        quantity: '830',
        unitRef: millimeterUnitRef,
      });

      const resolved = yield* resolverFor([currentBinding], [item]).resolve(requested);

      expect(resolved.quantity).toBe('830');
      expect(resolved.unitRef).toEqual(millimeterUnitRef);
      expect(resolved.stockItem.stockItemRef).toEqual(item.stockItemRef);
    }),
  );

  it.effect('uses a newer Configuration Definition revision as validation evidence without changing identity', () =>
    Effect.gen(function* reuseIdentityAcrossEvidenceRevision() {
      const originalSelection = configuredSelection({ definitionRevision: 7 });
      const reassessedSelection = configuredSelection({ definitionRevision: 8 });
      const meaning = exactMeaning('catalog-owner:configured-stable-meaning');
      const item = stockItem({
        exactSelectionMeaning: meaning,
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        unitRef: pieceUnitRef,
      });
      const currentBinding = binding({
        catalogSelection: originalSelection,
        exactSelectionMeaning: meaning,
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        stockItem: item,
      });
      const requested = demand({
        catalogSelection: reassessedSelection,
        exactSelectionMeaning: meaning,
        occurrence: 'purchase-demand-reassessed-configuration',
        quantity: '3',
        unitRef: pieceUnitRef,
      });

      const resolved = yield* resolverFor([currentBinding], [item]).resolve(requested);

      expect(originalSelection.configuration?.definition.revision).toBe(7);
      expect(resolved.catalogSelection.configuration?.definition.revision).toBe(8);
      expect(resolved.quantity).toBe('3');
      expect(resolved.stockItem.stockItemRef).toEqual(item.stockItemRef);
    }),
  );

  it.effect('rejects a reused meaning ID when value, target, or configuration Unit materially changes', () =>
    Effect.gen(function* rejectMaterialChangeBehindReusedIdentity() {
      const originalSelection = configuredSelection({ length: '500' });
      const meaning = exactMeaning('catalog-owner:configured-material-meaning');
      const item = stockItem({
        exactSelectionMeaning: meaning,
        id: '16161616-1616-4616-8616-161616161616',
        unitRef: pieceUnitRef,
      });
      const currentBinding = binding({
        catalogSelection: originalSelection,
        exactSelectionMeaning: meaning,
        id: '17171717-1717-4717-8717-171717171717',
        stockItem: item,
      });
      const resolveChanged = (selection: ReturnType<typeof configuredSelection>, occurrence: string) =>
        resolverFor([currentBinding], [item])
          .resolve(
            demand({
              catalogSelection: selection,
              exactSelectionMeaning: meaning,
              occurrence,
              quantity: '1',
              unitRef: pieceUnitRef,
            }),
          )
          .pipe(Effect.flip);

      const changedValue = yield* resolveChanged(
        configuredSelection({ length: '750' }),
        'purchase-demand-reused-value-meaning',
      );
      const changedTarget = yield* resolveChanged(
        configuredSelection({ variantId: '18181818-1818-4818-8818-181818181818' }),
        'purchase-demand-reused-target-meaning',
      );
      const changedConfigurationUnit = yield* resolveChanged(
        configuredSelection({ configurationUnitId: '19191919-1919-4919-8919-191919191919' }),
        'purchase-demand-reused-unit-meaning',
      );

      for (const error of [changedValue, changedTarget, changedConfigurationUnit]) {
        expect(Schema.is(ConfigurationStockItemBindingRejected)(error)).toBe(true);
        expect(error.reason).toBe('CONFIGURATION_MEANING_MISMATCH');
      }
    }),
  );

  it.effect('rejects an unrelated resolved occurrence instead of rebinding it to this demand', () =>
    Effect.gen(function* preserveOccurrenceProvenance() {
      const selection = configuredSelection({ length: '500' });
      const meaning = exactMeaning('catalog-owner:configured-occurrence-provenance');
      const item = stockItem({
        exactSelectionMeaning: meaning,
        id: '20202020-2020-4020-8020-202020202020',
        unitRef: pieceUnitRef,
      });
      const currentBinding = binding({
        catalogSelection: selection,
        exactSelectionMeaning: meaning,
        id: '21212121-2121-4121-8121-212121212121',
        stockItem: item,
      });
      const requested = demand({
        catalogSelection: selection,
        exactSelectionMeaning: meaning,
        occurrence: 'purchase-demand-occurrence-a',
        quantity: '2',
        unitRef: pieceUnitRef,
      });
      const otherOccurrence = demand({
        catalogSelection: selection,
        exactSelectionMeaning: meaning,
        occurrence: 'purchase-demand-occurrence-b',
        quantity: '2',
        unitRef: pieceUnitRef,
      });
      const canonical = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([currentBinding]) },
        { findById: () => Effect.succeed(Option.some(item)) },
      ).resolve(requested);
      const unrelatedResolved = {
        ...canonical,
        purchaseDemandOccurrenceId: otherOccurrence.purchaseDemandOccurrenceId,
      };

      const error = yield* preserveConfigurationStockDemand(requested, unrelatedResolved, currentBinding).pipe(
        Effect.flip,
      );
      const resolved = yield* preserveConfigurationStockDemand(requested, canonical, currentBinding);

      expect(error.reason).toBe('DEMAND_PROVENANCE_MISMATCH');
      expect(resolved.purchaseDemandOccurrenceId).toBe(requested.purchaseDemandOccurrenceId);
    }),
  );

  it.effect('requires a distinct exact meaning and binding for a material configuration change', () =>
    Effect.gen(function* requireDistinctBinding() {
      const originalSelection = configuredSelection({ length: '500' });
      const changedSelection = configuredSelection({
        configurationUnitId: '14141414-1414-4414-8414-141414141414',
        length: '750',
        variantId: '15151515-1515-4515-8515-151515151515',
      });
      const originalMeaning = exactMeaning('catalog-owner:configured-length-500');
      const changedMeaning = exactMeaning('catalog-owner:configured-length-750');
      const originalItem = stockItem({
        exactSelectionMeaning: originalMeaning,
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        unitRef: pieceUnitRef,
      });
      const changedItem = stockItem({
        exactSelectionMeaning: changedMeaning,
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        unitRef: pieceUnitRef,
      });
      const originalBinding = binding({
        catalogSelection: originalSelection,
        exactSelectionMeaning: originalMeaning,
        id: '12121212-1212-4212-8212-121212121212',
        stockItem: originalItem,
      });
      const changedBinding = binding({
        catalogSelection: changedSelection,
        exactSelectionMeaning: changedMeaning,
        id: '13131313-1313-4313-8313-131313131313',
        stockItem: changedItem,
      });
      const changedDemand = demand({
        catalogSelection: changedSelection,
        exactSelectionMeaning: changedMeaning,
        occurrence: 'purchase-demand-changed-configuration',
        quantity: '1',
        unitRef: pieceUnitRef,
      });

      const missing = yield* resolverFor([originalBinding], [originalItem]).resolve(changedDemand).pipe(Effect.flip);
      const resolved = yield* resolverFor([originalBinding, changedBinding], [originalItem, changedItem]).resolve(
        changedDemand,
      );

      expect(missing.reason).toBe('MISSING_BINDING');
      expect(resolved.stockItem.stockItemRef).toEqual(changedItem.stockItemRef);
      expect(resolved.stockItem.stockItemRef).not.toEqual(originalItem.stockItemRef);
    }),
  );
});
