import { PackageDefinitionSelectionRevisionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { Effect as EffectType } from 'effect';
import { Effect, Schema } from 'effect';

import { ResolvedCatalogStockDemandSchema } from './catalog-to-stock-binding.ts';
import type { ResolvedCatalogStockDemand } from './catalog-to-stock-binding.ts';

export const PackageStockRequirementSchema = Schema.Struct({
  ...ResolvedCatalogStockDemandSchema.fields,
  contentDecomposition: Schema.Literal('PROHIBITED'),
  packageContentRevision: PackageDefinitionSelectionRevisionSchema,
  stockRepresentation: Schema.Literal('ONE_EXACT_PACKAGE_STOCK_ITEM'),
});
export type PackageStockRequirement = typeof PackageStockRequirementSchema.Type;

export class PackageStockItemBindingRejected extends Schema.TaggedError<PackageStockItemBindingRejected>()(
  'PackageStockItemBindingRejected',
  {
    code: Schema.Literal('package_stock_item_binding_rejected'),
    exactSelectionMeaningId: ResolvedCatalogStockDemandSchema.fields.exactSelectionMeaning.fields.id,
    reason: Schema.Literals(['EXACT_SELECTION_IS_NOT_A_PACKAGE', 'PACKAGE_CONTENT_REVISION_MISSING']),
  },
) {}

const rejected = (
  demand: ResolvedCatalogStockDemand,
  reason: PackageStockItemBindingRejected['reason'],
): PackageStockItemBindingRejected =>
  new PackageStockItemBindingRejected({
    code: 'package_stock_item_binding_rejected',
    exactSelectionMeaningId: demand.exactSelectionMeaning.id,
    reason,
  });

/**
 * Specializes one already-resolved exact Catalog-to-Stock demand as a Package requirement.
 * The Package Content revision is retained only as Catalog definition evidence: contents are
 * never expanded, multiplied, substituted, converted, or allocated as loose component stock.
 */
export const resolvePackageStockRequirement = (
  resolved: ResolvedCatalogStockDemand,
): EffectType.Effect<PackageStockRequirement, PackageStockItemBindingRejected> => {
  if (resolved.exactSelectionMeaning.kind !== 'PACKAGE_OPTION') {
    return Effect.fail(rejected(resolved, 'EXACT_SELECTION_IS_NOT_A_PACKAGE'));
  }
  const packageContentRevision = resolved.catalogSelection.packageOption?.contentRevision;
  if (packageContentRevision === undefined) {
    return Effect.fail(rejected(resolved, 'PACKAGE_CONTENT_REVISION_MISSING'));
  }
  return Effect.succeed({
    ...resolved,
    contentDecomposition: 'PROHIBITED',
    packageContentRevision,
    stockRepresentation: 'ONE_EXACT_PACKAGE_STOCK_ITEM',
  });
};
