import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import type { Effect as EffectType } from 'effect';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { CatalogToStockBindingUnavailable } from './catalog-to-stock-binding-unavailable.ts';
import { ExactCatalogSelectionMeaningSchema, StockItemSchema } from './stock-item.ts';
import type { ExactCatalogSelectionMeaning, StockItem } from './stock-item.ts';
import { CatalogToStockBindingRefSchema } from '../resources/catalog-to-stock-binding.ts';
import type { CatalogToStockBindingRef } from '../resources/catalog-to-stock-binding.ts';

const boundedIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const QuantitySchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u), Schema.isMaxLength(80));

export const PurchaseDemandOccurrenceIdSchema = boundedIdentifier.pipe(
  Schema.brand('InventoryPurchaseDemandOccurrenceId'),
);

export const CatalogToStockBindingRevisionSchema = Schema.Int.check(
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }),
);
export const CatalogToStockBindingInstantSchema = Schema.toEncoded(Schema.DateTimeUtcFromString);
export const CatalogToStockBindingLifecycleEvidenceSchema = Schema.Struct({
  authority: Schema.Literal('INVENTORY_BINDING_OWNER'),
  ownerEvidenceRef: boundedIdentifier.pipe(Schema.brand('CatalogToStockBindingOwnerEvidenceRef')),
});
export type CatalogToStockBindingLifecycleEvidence = typeof CatalogToStockBindingLifecycleEvidenceSchema.Type;

export const CatalogToStockBindingSchema = Schema.Struct({
  bindingRef: CatalogToStockBindingRefSchema,
  catalogSelection: CatalogSelectionSchema,
  effectiveFrom: CatalogToStockBindingInstantSchema,
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
  revision: CatalogToStockBindingRevisionSchema,
  stockItemRef: StockItemSchema.fields.stockItemRef,
  unitRef: ProductUnitRefSchema,
}).check(
  Schema.makeFilter((binding) => {
    const { bindingRef, catalogSelection, stockItemRef, unitRef } = binding;
    const { tenantId } = catalogSelection.productRef;
    return [bindingRef.tenantId, stockItemRef.tenantId, unitRef.tenantId].every((candidate) => candidate === tenantId)
      ? undefined
      : 'Catalog Selection, binding, Stock Item, and Unit must share one Tenant';
  }),
);
export type CatalogToStockBinding = typeof CatalogToStockBindingSchema.Type;

export const CatalogToStockBindingHistoryEntrySchema = Schema.Struct({
  binding: CatalogToStockBindingSchema,
  endedAt: CatalogToStockBindingInstantSchema,
  ownerEvidenceRef: CatalogToStockBindingLifecycleEvidenceSchema.fields.ownerEvidenceRef,
  transition: Schema.Literals(['CORRECTED', 'ENDED', 'SUPERSEDED']),
});
export type CatalogToStockBindingHistoryEntry = typeof CatalogToStockBindingHistoryEntrySchema.Type;

export const CatalogToStockBindingEndInputSchema = Schema.Struct({
  bindingRef: CatalogToStockBindingRefSchema,
  disposition: Schema.Literals(['ENDED', 'SUPERSEDED']),
  evidence: CatalogToStockBindingLifecycleEvidenceSchema,
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
});
export type CatalogToStockBindingEndInput = typeof CatalogToStockBindingEndInputSchema.Type;

export const CatalogToStockBindingEndResultSchema = Schema.Struct({
  disposition: CatalogToStockBindingEndInputSchema.fields.disposition,
  historyEntry: CatalogToStockBindingHistoryEntrySchema,
});

export const CatalogToStockBindingCandidateSchema = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
  stockItem: StockItemSchema,
}).check(
  Schema.makeFilter(({ catalogSelection, stockItem }) =>
    catalogSelection.productRef.tenantId === stockItem.stockItemRef.tenantId
      ? undefined
      : 'Catalog Selection and Stock Item must share one Tenant',
  ),
);
export type CatalogToStockBindingCandidate = typeof CatalogToStockBindingCandidateSchema.Type;

export const CatalogToStockBindingCorrectionInputSchema = Schema.Struct({
  candidate: CatalogToStockBindingCandidateSchema,
  evidence: CatalogToStockBindingLifecycleEvidenceSchema,
});
export type CatalogToStockBindingCorrectionInput = typeof CatalogToStockBindingCorrectionInputSchema.Type;

export const CatalogStockDemandSchema = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
  purchaseDemandOccurrenceId: PurchaseDemandOccurrenceIdSchema,
  quantity: QuantitySchema,
  unitRef: ProductUnitRefSchema,
}).check(
  Schema.makeFilter(({ catalogSelection, unitRef }) =>
    catalogSelection.productRef.tenantId === unitRef.tenantId
      ? undefined
      : 'Catalog Selection and requested Unit must share one Tenant',
  ),
);
export type CatalogStockDemand = typeof CatalogStockDemandSchema.Type;

export const ResolvedCatalogStockDemandSchema = Schema.Struct({
  bindingRef: CatalogToStockBindingRefSchema,
  catalogSelection: CatalogSelectionSchema,
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
  purchaseDemandOccurrenceId: PurchaseDemandOccurrenceIdSchema,
  quantity: QuantitySchema,
  stockItem: StockItemSchema,
  unitRef: ProductUnitRefSchema,
});
export type ResolvedCatalogStockDemand = typeof ResolvedCatalogStockDemandSchema.Type;

export class CatalogToStockBindingRejected extends Schema.TaggedError<CatalogToStockBindingRejected>()(
  'CatalogToStockBindingRejected',
  {
    bindingRef: Schema.optionalKey(CatalogToStockBindingRefSchema),
    code: Schema.Literal('catalog_to_stock_binding_rejected'),
    reason: Schema.Literals([
      'MISSING_BINDING',
      'MULTIPLE_CURRENT_BINDINGS',
      'INTRINSIC_MEANING_MISMATCH',
      'STOCK_ITEM_NOT_FOUND',
      'STOCK_ITEM_NOT_CURRENT',
      'STOCK_UNIT_MISMATCH',
      'SELECTION_MEANING_ALREADY_BOUND',
      'STOCK_ITEM_ALREADY_BOUND',
      'BINDING_ID_CONFLICT',
      'REVISION_CONFLICT',
      'REPLACEMENT_MATCHES_CURRENT_TARGET',
      'TRANSITION_TIME_NOT_AFTER_CURRENT',
    ]),
    stockItemRef: Schema.optionalKey(StockItemSchema.fields.stockItemRef),
  },
) {}

export interface CatalogToStockBindingReader {
  readonly findCurrentByExactSelectionMeaning: (
    tenantId: string,
    exactSelectionMeaning: ExactCatalogSelectionMeaning,
  ) => EffectType.Effect<readonly CatalogToStockBinding[], CatalogToStockBindingUnavailable>;
}

export interface CatalogToStockBindingPersistence extends CatalogToStockBindingReader {
  readonly endCurrent: (input: {
    readonly current: CatalogToStockBinding;
    readonly historyEntry: CatalogToStockBindingHistoryEntry;
  }) => EffectType.Effect<
    CatalogToStockBindingHistoryEntry,
    CatalogToStockBindingRejected | CatalogToStockBindingUnavailable
  >;
  readonly findCurrentByStockItem: (
    stockItemRef: StockItem['stockItemRef'],
  ) => EffectType.Effect<Option.Option<CatalogToStockBinding>, CatalogToStockBindingUnavailable>;
  readonly insertCurrent: (
    binding: CatalogToStockBinding,
  ) => EffectType.Effect<CatalogToStockBinding, CatalogToStockBindingRejected | CatalogToStockBindingUnavailable>;
  readonly readHistory: (
    bindingRef: CatalogToStockBindingRef,
  ) => EffectType.Effect<readonly CatalogToStockBindingHistoryEntry[], CatalogToStockBindingUnavailable>;
  readonly replaceCurrent: (input: {
    readonly current: CatalogToStockBinding;
    readonly historyEntry: CatalogToStockBindingHistoryEntry;
    readonly next: CatalogToStockBinding;
  }) => EffectType.Effect<CatalogToStockBinding, CatalogToStockBindingRejected | CatalogToStockBindingUnavailable>;
}

export interface CatalogToStockBindingStockItemReader {
  readonly findById: (
    tenantId: string,
    stockItemId: string,
  ) => EffectType.Effect<Option.Option<StockItem>, CatalogToStockBindingUnavailable>;
}

const sameMeaning = (left: ExactCatalogSelectionMeaning, right: ExactCatalogSelectionMeaning) =>
  left.id === right.id && left.kind === right.kind;
const sameUnit = (left: StockItem['unitRef'], right: StockItem['unitRef']) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const rejected = (
  reason: CatalogToStockBindingRejected['reason'],
  bindingRef?: CatalogToStockBindingRef,
  stockItemRef?: StockItem['stockItemRef'],
) => {
  if (bindingRef !== undefined && stockItemRef !== undefined) {
    return new CatalogToStockBindingRejected({
      bindingRef,
      code: 'catalog_to_stock_binding_rejected',
      reason,
      stockItemRef,
    });
  }
  if (bindingRef !== undefined) {
    return new CatalogToStockBindingRejected({ bindingRef, code: 'catalog_to_stock_binding_rejected', reason });
  }
  if (stockItemRef !== undefined) {
    return new CatalogToStockBindingRejected({ code: 'catalog_to_stock_binding_rejected', reason, stockItemRef });
  }
  return new CatalogToStockBindingRejected({ code: 'catalog_to_stock_binding_rejected', reason });
};

export const makeCatalogToStockBindingResolver = (
  bindings: CatalogToStockBindingReader,
  stockItems: CatalogToStockBindingStockItemReader,
) => ({
  resolve: (demand: CatalogStockDemand) =>
    bindings
      .findCurrentByExactSelectionMeaning(demand.catalogSelection.productRef.tenantId, demand.exactSelectionMeaning)
      .pipe(
        Effect.flatMap((current) => {
          const [binding] = current;
          if (binding === undefined) {
            return Effect.fail(rejected('MISSING_BINDING'));
          }
          if (current.length !== 1) {
            return Effect.fail(rejected('MULTIPLE_CURRENT_BINDINGS'));
          }
          return stockItems.findById(binding.stockItemRef.tenantId, binding.stockItemRef.resourceId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(rejected('STOCK_ITEM_NOT_FOUND', binding.bindingRef, binding.stockItemRef)),
                onSome: (stockItem) => {
                  if (
                    !sameMeaning(binding.exactSelectionMeaning, demand.exactSelectionMeaning) ||
                    !sameMeaning(stockItem.exactSelectionMeaning, demand.exactSelectionMeaning)
                  ) {
                    return Effect.fail(
                      rejected('INTRINSIC_MEANING_MISMATCH', binding.bindingRef, stockItem.stockItemRef),
                    );
                  }
                  if (stockItem.lifecycle !== 'CURRENT') {
                    return Effect.fail(rejected('STOCK_ITEM_NOT_CURRENT', binding.bindingRef, stockItem.stockItemRef));
                  }
                  if (!sameUnit(binding.unitRef, demand.unitRef) || !sameUnit(stockItem.unitRef, demand.unitRef)) {
                    return Effect.fail(rejected('STOCK_UNIT_MISMATCH', binding.bindingRef, stockItem.stockItemRef));
                  }
                  return Effect.succeed({
                    bindingRef: binding.bindingRef,
                    catalogSelection: demand.catalogSelection,
                    exactSelectionMeaning: demand.exactSelectionMeaning,
                    purchaseDemandOccurrenceId: demand.purchaseDemandOccurrenceId,
                    quantity: demand.quantity,
                    stockItem,
                    unitRef: demand.unitRef,
                  } satisfies ResolvedCatalogStockDemand);
                },
              }),
            ),
          );
        }),
      ),
});

const requireSingleCurrent = (
  current: readonly CatalogToStockBinding[],
): EffectType.Effect<CatalogToStockBinding, CatalogToStockBindingRejected> => {
  const [binding] = current;
  if (binding === undefined) {
    return Effect.fail(rejected('MISSING_BINDING'));
  }
  return current.length === 1 ? Effect.succeed(binding) : Effect.fail(rejected('MULTIPLE_CURRENT_BINDINGS'));
};

const requireLaterTransition = (
  current: CatalogToStockBinding,
  transitionAt: CatalogToStockBinding['effectiveFrom'],
): EffectType.Effect<CatalogToStockBinding['effectiveFrom'], CatalogToStockBindingRejected> =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(transitionAt)) >
  DateTime.toEpochMillis(DateTime.makeUnsafe(current.effectiveFrom))
    ? Effect.succeed(transitionAt)
    : Effect.fail(rejected('TRANSITION_TIME_NOT_AFTER_CURRENT', current.bindingRef, current.stockItemRef));

const validateCandidate = (
  candidate: CatalogToStockBindingCandidate,
): EffectType.Effect<CatalogToStockBindingCandidate, CatalogToStockBindingRejected> => {
  if (!sameMeaning(candidate.stockItem.exactSelectionMeaning, candidate.exactSelectionMeaning)) {
    return Effect.fail(rejected('INTRINSIC_MEANING_MISMATCH', undefined, candidate.stockItem.stockItemRef));
  }
  if (candidate.stockItem.lifecycle !== 'CURRENT') {
    return Effect.fail(rejected('STOCK_ITEM_NOT_CURRENT', undefined, candidate.stockItem.stockItemRef));
  }
  return Effect.succeed(candidate);
};

const replaceBindingTarget = (
  persistence: CatalogToStockBindingPersistence,
  current: CatalogToStockBinding,
  candidate: CatalogToStockBindingCandidate,
  evidence: CatalogToStockBindingLifecycleEvidence,
  correctedAt: CatalogToStockBinding['effectiveFrom'],
) =>
  Schema.decodeEffect(CatalogToStockBindingSchema)({
    ...current,
    effectiveFrom: correctedAt,
    exactSelectionMeaning: candidate.exactSelectionMeaning,
    revision: current.revision + 1,
    stockItemRef: candidate.stockItem.stockItemRef,
    unitRef: candidate.stockItem.unitRef,
  }).pipe(
    Effect.orDie,
    Effect.flatMap((next) =>
      persistence.replaceCurrent({
        current,
        historyEntry: {
          binding: current,
          endedAt: correctedAt,
          ownerEvidenceRef: evidence.ownerEvidenceRef,
          transition: 'CORRECTED',
        },
        next,
      }),
    ),
  );

export const makeCatalogToStockBindingLifecycle = (
  persistence: CatalogToStockBindingPersistence,
  options: {
    readonly makeBindingId: () => string;
    readonly now: EffectType.Effect<CatalogToStockBinding['effectiveFrom']>;
  },
) =>
  /* oxlint-disable perfectionist/sort-objects -- Canonical public lifecycle order is establish, correct, end; issue #827 owns this exact exception; expires: 2027-03-31. */
  ({
    establish: (candidate: CatalogToStockBindingCandidate) =>
      validateCandidate(candidate).pipe(
        Effect.flatMap(() =>
          persistence.findCurrentByExactSelectionMeaning(
            candidate.catalogSelection.productRef.tenantId,
            candidate.exactSelectionMeaning,
          ),
        ),
        Effect.flatMap((existing) =>
          existing.length === 0
            ? Effect.void
            : Effect.fail(
                rejected(existing.length === 1 ? 'SELECTION_MEANING_ALREADY_BOUND' : 'MULTIPLE_CURRENT_BINDINGS'),
              ),
        ),
        Effect.flatMap(() => persistence.findCurrentByStockItem(candidate.stockItem.stockItemRef)),
        Effect.flatMap(
          Option.match({
            onNone: () => options.now,
            onSome: (existing) =>
              Effect.fail(rejected('STOCK_ITEM_ALREADY_BOUND', existing.bindingRef, existing.stockItemRef)),
          }),
        ),
        Effect.flatMap((effectiveFrom) =>
          Schema.decodeEffect(CatalogToStockBindingSchema)({
            bindingRef: {
              moduleId: 'commerce.inventory',
              resourceId: options.makeBindingId(),
              resourceType: 'commerce.inventory.catalog-to-stock-binding',
              tenantId: candidate.catalogSelection.productRef.tenantId,
            },
            catalogSelection: candidate.catalogSelection,
            effectiveFrom,
            exactSelectionMeaning: candidate.exactSelectionMeaning,
            revision: 1,
            stockItemRef: candidate.stockItem.stockItemRef,
            unitRef: candidate.stockItem.unitRef,
          }).pipe(Effect.orDie),
        ),
        Effect.flatMap(persistence.insertCurrent),
      ),
    correct: ({ candidate, evidence }: CatalogToStockBindingCorrectionInput) =>
      validateCandidate(candidate).pipe(
        Effect.flatMap(() =>
          persistence.findCurrentByExactSelectionMeaning(
            candidate.catalogSelection.productRef.tenantId,
            candidate.exactSelectionMeaning,
          ),
        ),
        Effect.flatMap(requireSingleCurrent),
        Effect.flatMap((current) => {
          if (!sameMeaning(current.exactSelectionMeaning, candidate.exactSelectionMeaning)) {
            return Effect.fail(
              rejected('INTRINSIC_MEANING_MISMATCH', current.bindingRef, candidate.stockItem.stockItemRef),
            );
          }
          if (!sameUnit(current.unitRef, candidate.stockItem.unitRef)) {
            return Effect.fail(rejected('STOCK_UNIT_MISMATCH', current.bindingRef, candidate.stockItem.stockItemRef));
          }
          if (current.stockItemRef.resourceId === candidate.stockItem.stockItemRef.resourceId) {
            return Effect.fail(
              rejected('REPLACEMENT_MATCHES_CURRENT_TARGET', current.bindingRef, current.stockItemRef),
            );
          }
          return persistence.findCurrentByStockItem(candidate.stockItem.stockItemRef).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => options.now,
                onSome: (existing) =>
                  Effect.fail(rejected('STOCK_ITEM_ALREADY_BOUND', existing.bindingRef, existing.stockItemRef)),
              }),
            ),
            Effect.flatMap((correctedAt) => requireLaterTransition(current, correctedAt)),
            Effect.flatMap((correctedAt) =>
              replaceBindingTarget(persistence, current, candidate, evidence, correctedAt),
            ),
          );
        }),
      ),
    end: (input: CatalogToStockBindingEndInput) =>
      persistence.findCurrentByExactSelectionMeaning(input.bindingRef.tenantId, input.exactSelectionMeaning).pipe(
        Effect.flatMap(requireSingleCurrent),
        Effect.flatMap((current) =>
          current.bindingRef.moduleId === input.bindingRef.moduleId &&
          current.bindingRef.resourceId === input.bindingRef.resourceId &&
          current.bindingRef.resourceType === input.bindingRef.resourceType &&
          current.bindingRef.tenantId === input.bindingRef.tenantId
            ? options.now.pipe(
                Effect.flatMap((endedAt) => requireLaterTransition(current, endedAt)),
                Effect.flatMap((endedAt) =>
                  persistence.endCurrent({
                    current,
                    historyEntry: {
                      binding: current,
                      endedAt,
                      ownerEvidenceRef: input.evidence.ownerEvidenceRef,
                      transition: input.disposition,
                    },
                  }),
                ),
                Effect.map((historyEntry) => ({ disposition: input.disposition, historyEntry })),
              )
            : Effect.fail(rejected('BINDING_ID_CONFLICT', current.bindingRef, current.stockItemRef)),
        ),
      ),
  });
/* oxlint-enable perfectionist/sort-objects */
