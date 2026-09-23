/* oxlint-disable effect-native/no-unbranded-identifier-schema -- Catalog owns these opaque evidence references; this consumer preserves them without assigning local business meaning; tracked in: #333. */
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Schema } from 'effect';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { CommerceQuantityBasisSchema, ExactPositiveCommerceQuantitySchema } from './customer-commerce-policy.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

/**
 * Exact Current Catalog facts consumed by quantity resolution. Every identity and revision is
 * issued by Catalog; Customer Context never traverses Catalog hierarchy or normalizes Quantity.
 */
const CurrentCommerceQuantityCatalogSelectionSchema = Schema.Struct({
  basis: CommerceQuantityBasisSchema,
  catalogSelection: CatalogSelectionSchema,
  completeness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  divisible: Schema.Boolean,
  equivalentSelectionKey: stableReference,
  hierarchyRevision: stableReference,
  normalizedQuantity: ExactPositiveCommerceQuantitySchema,
  ownerRevision: stableReference,
  physicalMultiple: ExactPositiveCommerceQuantitySchema,
  requestedQuantity: ExactPositiveCommerceQuantitySchema,
}).check(
  Schema.makeFilter((selection) => {
    const tenantIds = [
      selection.catalogSelection.productRef.tenantId,
      selection.catalogSelection.variantRef.tenantId,
      selection.catalogSelection.packageOption?.optionRef.tenantId,
      selection.basis.targetRef.tenantId,
      selection.basis.unitRef.tenantId,
    ].filter((tenantId): tenantId is string => tenantId !== undefined);
    return tenantIds.every((tenantId) => tenantId === selection.catalogSelection.productRef.tenantId)
      ? undefined
      : 'Catalog selection, hierarchy, and Quantity basis must belong to one Tenant';
  }),
);
export type CurrentCommerceQuantityCatalogSelection = typeof CurrentCommerceQuantityCatalogSelectionSchema.Type;

export const CommerceQuantityCatalogLineRequestSchema = Schema.Struct({
  lineId: stableReference,
  requestedQuantity: ExactPositiveCommerceQuantitySchema,
  selection: CatalogSelectionSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommerceQuantityCatalogLineRequest = typeof CommerceQuantityCatalogLineRequestSchema.Type;

export const CurrentCommerceQuantityCatalogLineSchema = Schema.Struct({
  lineId: stableReference,
  selection: CurrentCommerceQuantityCatalogSelectionSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CurrentCommerceQuantityCatalogLine = typeof CurrentCommerceQuantityCatalogLineSchema.Type;

export const CommerceQuantityCatalogUnavailableSchema = Schema.TaggedStruct('CommerceQuantityCatalogUnavailable', {
  code: Schema.Literals([
    'catalog_selection_invalid',
    'catalog_selection_stale',
    'catalog_selection_unavailable',
    'catalog_selection_unverifiable',
    'catalog_quantity_normalization_unavailable',
  ]),
  reason: Schema.String,
  retryable: Schema.Literal(true),
});
export type CommerceQuantityCatalogUnavailable = typeof CommerceQuantityCatalogUnavailableSchema.Type;

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The governed Read factory supplies this narrow Catalog owner port explicitly rather than through ambient Context.
export interface CommerceQuantityCatalogPortService {
  readonly resolveCurrentSelections: (input: {
    readonly lines: readonly CommerceQuantityCatalogLineRequest[];
    readonly observedAt: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly CurrentCommerceQuantityCatalogLine[], CommerceQuantityCatalogUnavailable>;
}

/** Production stays fail-closed until Catalog publishes and wires its owner-issued adapter. */
export const unavailableCommerceQuantityCatalogPort = (): CommerceQuantityCatalogPortService => ({
  resolveCurrentSelections: () =>
    Effect.fail({
      _tag: 'CommerceQuantityCatalogUnavailable',
      code: 'catalog_selection_unavailable',
      reason: 'The Current Catalog Selection and Quantity Normalization provider is not configured',
      retryable: true,
    }),
});
