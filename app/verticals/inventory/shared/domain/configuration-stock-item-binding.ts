import { Effect, Schema } from 'effect';

import type {
  CatalogStockDemand,
  CatalogToStockBinding,
  ResolvedCatalogStockDemand,
} from './catalog-to-stock-binding.ts';

type ProductConfiguration = Exclude<CatalogStockDemand['catalogSelection']['configuration'], undefined>;

export type ConfigurationStockDemand = Omit<CatalogStockDemand, 'catalogSelection'> & {
  readonly catalogSelection: CatalogStockDemand['catalogSelection'] & {
    readonly configuration: ProductConfiguration;
  };
};

export type ResolvedConfigurationStockDemand = Omit<ResolvedCatalogStockDemand, 'catalogSelection'> & {
  readonly catalogSelection: ConfigurationStockDemand['catalogSelection'];
};

export class ConfigurationStockItemBindingRejected extends Schema.TaggedError<ConfigurationStockItemBindingRejected>()(
  'ConfigurationStockItemBindingRejected',
  {
    code: Schema.Literal('configuration_stock_item_binding_rejected'),
    reason: Schema.Literals([
      'BINDING_PROVENANCE_MISMATCH',
      'CONFIGURATION_MEANING_MISMATCH',
      'DEMAND_PROVENANCE_MISMATCH',
    ]),
  },
) {}

interface ResourceIdentity {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const sameResource = (left: ResourceIdentity, right: ResourceIdentity): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameOptionalRevisionResource = (
  left: { readonly resourceRef: ResourceIdentity } | undefined,
  right: { readonly resourceRef: ResourceIdentity } | undefined,
): boolean =>
  left === undefined ? right === undefined : right !== undefined && sameResource(left.resourceRef, right.resourceRef);

const sameConfigurationMeaning = (left: ProductConfiguration, right: ProductConfiguration): boolean =>
  sameResource(left.productRef, right.productRef) &&
  sameResource(left.variantRef, right.variantRef) &&
  sameResource(left.definition.resourceRef, right.definition.resourceRef) &&
  left.choices.length === right.choices.length &&
  left.choices.every((leftChoice) => {
    const rightChoice = right.choices.find((candidate) => candidate.choiceKey === leftChoice.choiceKey);
    return (
      rightChoice !== undefined &&
      leftChoice.value === rightChoice.value &&
      sameOptionalRevisionResource(leftChoice.attributeDefinition, rightChoice.attributeDefinition) &&
      sameOptionalRevisionResource(leftChoice.unit, rightChoice.unit)
    );
  });

const sameExactMeaning = (
  left: CatalogStockDemand['exactSelectionMeaning'],
  right: CatalogStockDemand['exactSelectionMeaning'],
): boolean => left.id === right.id && left.kind === right.kind;

const rejected = (reason: ConfigurationStockItemBindingRejected['reason']) =>
  new ConfigurationStockItemBindingRejected({ code: 'configuration_stock_item_binding_rejected', reason });

/**
 * Validates configured demand against the exact binding that canonical resolution selected.
 * Catalog revision numbers are evidence only; target, choice values, and referenced configuration Resources are meaning.
 */
export const preserveConfigurationStockDemand = (
  demand: ConfigurationStockDemand,
  resolved: ResolvedCatalogStockDemand,
  binding: CatalogToStockBinding,
): Effect.Effect<ResolvedConfigurationStockDemand, ConfigurationStockItemBindingRejected> => {
  if (
    !sameResource(resolved.bindingRef, binding.bindingRef) ||
    !sameResource(resolved.stockItem.stockItemRef, binding.stockItemRef) ||
    !sameExactMeaning(resolved.exactSelectionMeaning, binding.exactSelectionMeaning) ||
    !sameExactMeaning(demand.exactSelectionMeaning, binding.exactSelectionMeaning)
  ) {
    return Effect.fail(rejected('BINDING_PROVENANCE_MISMATCH'));
  }

  const boundConfiguration = binding.catalogSelection.configuration;
  if (
    boundConfiguration === undefined ||
    !sameResource(demand.catalogSelection.productRef, binding.catalogSelection.productRef) ||
    !sameResource(demand.catalogSelection.variantRef, binding.catalogSelection.variantRef) ||
    !sameConfigurationMeaning(demand.catalogSelection.configuration, boundConfiguration)
  ) {
    return Effect.fail(rejected('CONFIGURATION_MEANING_MISMATCH'));
  }

  const resolvedConfiguration = resolved.catalogSelection.configuration;
  if (
    resolvedConfiguration === undefined ||
    !sameResource(resolved.catalogSelection.productRef, demand.catalogSelection.productRef) ||
    !sameResource(resolved.catalogSelection.variantRef, demand.catalogSelection.variantRef) ||
    !sameConfigurationMeaning(resolvedConfiguration, demand.catalogSelection.configuration) ||
    resolved.purchaseDemandOccurrenceId !== demand.purchaseDemandOccurrenceId ||
    resolved.quantity !== demand.quantity ||
    !sameResource(resolved.unitRef, demand.unitRef) ||
    !sameResource(binding.unitRef, demand.unitRef) ||
    !sameResource(resolved.stockItem.unitRef, demand.unitRef)
  ) {
    return Effect.fail(rejected('DEMAND_PROVENANCE_MISMATCH'));
  }

  return Effect.succeed({
    ...resolved,
    catalogSelection: demand.catalogSelection,
  });
};
