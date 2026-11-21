import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import type { VariantRef } from '@app/catalog-selection-contracts/resources/variant';
import { Array as EffectArray, Effect, Match, Option, Schema } from 'effect';

import { CatalogVariantOnHandPageResponseSchema } from '../../shared/apis/catalog-variant-on-hand-page.ts';
import type {
  CatalogVariantOnHand,
  CatalogVariantOnHandPageRequest,
  CatalogVariantPositionOnHand,
  CatalogVariantStockItem,
  CatalogVariantStockPosition,
} from '../../shared/apis/catalog-variant-on-hand-page.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import type {
  InventorySourceAssertion,
  InventorySourceAssertionEvaluation,
} from '../../shared/domain/inventory-source-assertion.ts';
import type { PhysicalStockEffectRecord } from '../../shared/domain/physical-stock-effect.ts';
import { addExactStockQuantityAmounts, IndeterminateOnHandEvidenceSchema } from '../../shared/domain/stock-position.ts';
import type { StockPosition, StockQuantity } from '../../shared/domain/stock-position.ts';
import type { StockPositionRef } from '../../shared/resources/stock-position.ts';
import { evaluateInventorySourceAssertionCoverage } from '../domain/inventory-source-assertion-evaluator.ts';
import type {
  CatalogVariantBinding,
  CatalogVariantPositionRow,
} from '../persistence/catalog-variant-on-hand-page-repository.ts';

/** The owner reads one page needs, each already in the read's unavailable channel. */
export interface CatalogVariantOnHandPageServices {
  readonly findConfiguration: (
    customerConfigurationId: string,
  ) => Effect.Effect<Option.Option<InventoryBackendConfiguration>, ReadHandlerUnavailable>;
  readonly listBindings: (
    variantIds: readonly string[],
  ) => Effect.Effect<readonly CatalogVariantBinding[], ReadHandlerUnavailable>;
  readonly listMaterialEffects: (
    positionRef: StockPositionRef,
  ) => Effect.Effect<readonly PhysicalStockEffectRecord[], ReadHandlerUnavailable>;
  readonly listPositions: (input: {
    readonly configurationId: string;
    readonly customerConfigurationId: string;
    readonly stockItemIds: readonly string[];
  }) => Effect.Effect<readonly CatalogVariantPositionRow[], ReadHandlerUnavailable>;
  readonly readLatestSourceAssertion: (
    positionRef: StockPositionRef,
  ) => Effect.Effect<Option.Option<InventorySourceAssertion>, ReadHandlerUnavailable>;
  readonly readPosition: (
    positionRef: StockPositionRef,
  ) => Effect.Effect<Option.Option<StockPosition>, ReadHandlerUnavailable>;
}

export const catalogVariantOnHandPageUnavailable = (cause?: unknown) => {
  const failure = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Catalog Variant on-hand page is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const notFound = (reason: string) => new ReadHandlerNotFound({ code: 'read_handler_not_found', reason });

const notEstablished = (state: Extract<CatalogVariantPositionOnHand, { _tag: 'NOT_ESTABLISHED' }>['state']) =>
  ({ _tag: 'NOT_ESTABLISHED', state }) as const;

/** OntOS WMS: the Position's own Current ON_HAND is the figure; any other Stock Evidence state is none. */
export const ownerRecordedOnHand = (position: StockPosition): CatalogVariantPositionOnHand =>
  Match.value(position.onHand).pipe(
    Match.tag('CURRENT', ({ observedAt, quantity }) => ({ _tag: 'OWNER_RECORDED' as const, observedAt, quantity })),
    Match.tag('UNKNOWN', 'MISSING', 'STALE', 'INDETERMINATE', ({ _tag }) => notEstablished(_tag)),
    Match.exhaustive,
  );

/**
 * External Business System: the latest accepted Source Assertion is the figure only when it is determinate against
 * Inventory's own physical effects. Pre-cutover or predated evidence is STALE; missing or unknown coverage is
 * INDETERMINATE.
 */
export const sourceReportedOnHand = (
  assertion: InventorySourceAssertion,
  evaluation: InventorySourceAssertionEvaluation,
): CatalogVariantPositionOnHand =>
  Match.value(evaluation).pipe(
    Match.tag('DETERMINATE', ({ postEffectOnHand }) => ({
      _tag: 'SOURCE_REPORTED' as const,
      quantity: postEffectOnHand,
      receivedAt: assertion.receivedAt,
      sourceObservedAt: assertion.businessObservedAt,
    })),
    Match.tag('HISTORICAL', () => notEstablished('STALE')),
    Match.tag('INDETERMINATE', () => notEstablished('INDETERMINATE')),
    Match.exhaustive,
  );

const positionOnHand = Effect.fn('CatalogVariantOnHandPage.positionOnHand')(function* positionOnHand(
  services: CatalogVariantOnHandPageServices,
  configuration: InventoryBackendConfiguration,
  position: StockPosition,
) {
  if (configuration.selection.backend === 'ontos_wms') {
    return ownerRecordedOnHand(position);
  }
  // An open source conflict made the Position INDETERMINATE; an earlier accepted figure is not shown over it.
  if (Schema.is(IndeterminateOnHandEvidenceSchema)(position.onHand)) {
    return notEstablished('INDETERMINATE');
  }
  const latest = yield* services.readLatestSourceAssertion(position.ref);
  if (Option.isNone(latest)) {
    // No accepted figure yet: a new Position starts UNKNOWN and is never shown as zero.
    return notEstablished('UNKNOWN');
  }
  const materialEffects = yield* services.listMaterialEffects(position.ref);
  const evaluation = yield* evaluateInventorySourceAssertionCoverage(latest.value, materialEffects).pipe(
    Effect.mapError(catalogVariantOnHandPageUnavailable),
  );
  return sourceReportedOnHand(latest.value, evaluation);
});

/** The bound Stock Items of the Variant itself: a Package, Set or configuration of it is another selection. */
export const variantStockItems = (
  variantRef: VariantRef,
  bindings: readonly CatalogVariantBinding[],
): readonly CatalogVariantStockItem[] =>
  bindings.flatMap(({ catalogSelection, stockItem }) =>
    catalogSelection.variantRef.resourceId === variantRef.resourceId &&
    catalogSelection.variantRef.tenantId === variantRef.tenantId &&
    catalogSelection.packageOption === undefined &&
    catalogSelection.configuration === undefined &&
    catalogSelection.setComposition === undefined
      ? [stockItem]
      : [],
  );

const sameUnit = (left: StockQuantity['unitRef'], right: StockQuantity['unitRef']) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/** The Variant's outcome from its bound Stock Items and that Stock Item's Positions, in Location order. */
export const variantOnHand = (
  variantRef: VariantRef,
  stockItems: readonly CatalogVariantStockItem[],
  positions: readonly CatalogVariantStockPosition[],
): Effect.Effect<CatalogVariantOnHand, ReadHandlerUnavailable> => {
  const [stockItem] = stockItems;
  if (stockItem === undefined) {
    return Effect.succeed({ outcome: 'NO_STOCK_ITEM', variantRef });
  }
  if (stockItems.length > 1) {
    return Effect.succeed({
      outcome: 'CONFLICTING_BINDINGS',
      stockItemRefs: stockItems.map(({ stockItemRef }) => stockItemRef),
      variantRef,
    });
  }
  if (!EffectArray.isReadonlyArrayNonEmpty(positions)) {
    return Effect.succeed({ outcome: 'NO_POSITION', stockItem, variantRef });
  }
  const figures = positions.flatMap(({ onHand }) =>
    Match.value(onHand).pipe(
      Match.tag('SOURCE_REPORTED', 'OWNER_RECORDED', ({ quantity }) => [quantity]),
      Match.tag('NOT_ESTABLISHED', () => []),
      Match.exhaustive,
    ),
  );
  const [first, ...rest] = figures;
  if (first === undefined || figures.length !== positions.length) {
    return Effect.succeed({ outcome: 'ON_HAND_UNKNOWN', positions, stockItem, variantRef });
  }
  if (figures.some(({ unitRef }) => !sameUnit(unitRef, stockItem.unitRef))) {
    return Effect.fail(catalogVariantOnHandPageUnavailable('A Stock Position figure is not in its Stock Item Unit'));
  }
  return Effect.reduce(
    rest,
    () => first.amount,
    (subtotal, { amount }) => Effect.fromResult(addExactStockQuantityAmounts(subtotal, amount)),
  ).pipe(
    Effect.mapError(catalogVariantOnHandPageUnavailable),
    Effect.map((amount) => ({
      outcome: 'ON_HAND' as const,
      positions,
      stockItem,
      total: { amount, unitRef: stockItem.unitRef },
      variantRef,
    })),
  );
};

/**
 * One item per requested Variant, in request order. Variants of another Tenant and a Customer Configuration
 * without a selected Inventory Backend are not found.
 */
export const readCatalogVariantOnHandPage = Effect.fn('CatalogVariantOnHandPage.read')(
  function* readCatalogVariantOnHandPage(
    input: CatalogVariantOnHandPageRequest,
    services: CatalogVariantOnHandPageServices,
    scope: Pick<OperationalScope, 'tenantId'>,
  ) {
    if (input.variantRefs.some(({ tenantId }) => tenantId !== scope.tenantId)) {
      return yield* notFound('A Catalog Variant is outside the trusted Tenant');
    }
    const found = yield* services.findConfiguration(input.customerConfigurationId);
    if (Option.isNone(found)) {
      return yield* notFound('No Inventory Backend is selected for the Customer Configuration');
    }
    const configuration = found.value;
    const bindings = yield* services.listBindings(input.variantRefs.map(({ resourceId }) => resourceId));
    const variants = input.variantRefs.map((variantRef) => ({
      stockItems: variantStockItems(variantRef, bindings),
      variantRef,
    }));
    const stockItemIds = variants.flatMap(({ stockItems }) =>
      stockItems.length === 1 ? stockItems.map(({ stockItemRef }) => stockItemRef.resourceId) : [],
    );
    const rows =
      stockItemIds.length === 0
        ? []
        : yield* services.listPositions({
            configurationId: configuration.configurationId,
            customerConfigurationId: input.customerConfigurationId,
            stockItemIds,
          });
    const positions = yield* Effect.forEach(
      rows,
      Effect.fn('CatalogVariantOnHandPage.position')(function* stockPositionOf(row) {
        const position = yield* services.readPosition(row.positionRef);
        if (Option.isNone(position)) {
          return yield* catalogVariantOnHandPageUnavailable('A listed Stock Position could not be read');
        }
        const entry: CatalogVariantStockPosition = {
          onHand: yield* positionOnHand(services, configuration, position.value),
          positionRef: row.positionRef,
          stockLocation: row.stockLocation,
        };
        return { entry, stockItemId: row.stockItemId };
      }),
      { concurrency: 1 },
    );
    const items = yield* Effect.forEach(
      variants,
      ({ stockItems, variantRef }) =>
        variantOnHand(
          variantRef,
          stockItems,
          positions.flatMap(({ entry, stockItemId }) =>
            stockItems.length === 1 && stockItems[0]?.stockItemRef.resourceId === stockItemId ? [entry] : [],
          ),
        ),
      { concurrency: 1 },
    );
    return yield* Schema.decodeUnknownEffect(CatalogVariantOnHandPageResponseSchema)({
      backend: { backendId: configuration.selection.backendId, kind: configuration.selection.backend },
      customerConfigurationId: input.customerConfigurationId,
      items,
      purpose: 'INFORMATIONAL_DISPLAY',
      sharingEligibility: 'NOT_EVALUATED',
    }).pipe(Effect.mapError(catalogVariantOnHandPageUnavailable));
  },
);
