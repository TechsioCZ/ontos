import { SetCompositionSelectionRevisionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { Effect as EffectType } from 'effect';
import { Effect, Schema } from 'effect';

import { ResolvedCatalogStockDemandSchema } from './catalog-to-stock-binding.ts';
import type { ResolvedCatalogStockDemand } from './catalog-to-stock-binding.ts';

export const FixedSetStockRequirementSchema = Schema.Struct({
  ...ResolvedCatalogStockDemandSchema.fields,
  componentDecomposition: Schema.Literal('PROHIBITED'),
  setCompositionRevision: SetCompositionSelectionRevisionSchema,
  stockRepresentation: Schema.Literal('ONE_EXACT_SET_STOCK_ITEM'),
});
export type FixedSetStockRequirement = typeof FixedSetStockRequirementSchema.Type;

export class FixedSetStockItemBindingRejected extends Schema.TaggedError<FixedSetStockItemBindingRejected>()(
  'FixedSetStockItemBindingRejected',
  {
    code: Schema.Literal('fixed_set_stock_item_binding_rejected'),
    exactSelectionMeaningId: ResolvedCatalogStockDemandSchema.fields.exactSelectionMeaning.fields.id,
    reason: Schema.Literals(['EXACT_SELECTION_IS_NOT_A_SET', 'SET_COMPOSITION_REVISION_MISSING']),
  },
) {}

const rejected = (
  demand: ResolvedCatalogStockDemand,
  reason: FixedSetStockItemBindingRejected['reason'],
): FixedSetStockItemBindingRejected =>
  new FixedSetStockItemBindingRejected({
    code: 'fixed_set_stock_item_binding_rejected',
    exactSelectionMeaningId: demand.exactSelectionMeaning.id,
    reason,
  });

/**
 * Specializes the exact Catalog-to-Stock binding for a Set without inspecting,
 * multiplying, substituting, or allocating any component stock.
 */
export const resolveFixedSetStockRequirement = (
  resolved: ResolvedCatalogStockDemand,
): EffectType.Effect<FixedSetStockRequirement, FixedSetStockItemBindingRejected> => {
  if (resolved.exactSelectionMeaning.kind !== 'SET_VARIANT') {
    return Effect.fail(rejected(resolved, 'EXACT_SELECTION_IS_NOT_A_SET'));
  }
  const setCompositionRevision = resolved.catalogSelection.setComposition;
  if (setCompositionRevision === undefined) {
    return Effect.fail(rejected(resolved, 'SET_COMPOSITION_REVISION_MISSING'));
  }
  return Effect.succeed({
    ...resolved,
    componentDecomposition: 'PROHIBITED',
    setCompositionRevision,
    stockRepresentation: 'ONE_EXACT_SET_STOCK_ITEM',
  });
};
