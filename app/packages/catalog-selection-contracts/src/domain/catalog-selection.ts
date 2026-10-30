import { Schema } from 'effect';

import {
  CatalogResourceRefSchema,
  CatalogRevisionIdSchema,
  CatalogRevisionNumberSchema,
} from './catalog-resource-reference.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const choiceKeySchema = nonEmptyText.pipe(Schema.brand('CatalogConfigurationChoiceKey'));
const packageDefinitionType = 'commerce.catalog.package-definition';
const productType = 'commerce.catalog.product';
const variantType = 'commerce.catalog.variant';
const attributeDefinitionType = 'commerce.catalog.attribute-definition';
const configurationUnitType = 'commerce.catalog.unit';
const configurationDefinitionType = 'commerce.catalog.configuration-definition';
const setCompositionType = 'commerce.catalog.set-composition';

/** An owner-issued business revision; no revision ID is invented when the owner issues only a sequence. */
export const CatalogSelectionRevisionSchema = Schema.Struct({
  resourceRef: CatalogResourceRefSchema,
  revision: CatalogRevisionNumberSchema,
  revisionId: Schema.optionalKey(CatalogRevisionIdSchema),
});
export type CatalogSelectionRevision = typeof CatalogSelectionRevisionSchema.Type;

const revisionOf = (resourceType: string) =>
  CatalogSelectionRevisionSchema.check(
    Schema.makeFilter(({ resourceRef }) =>
      resourceRef.resourceType === resourceType ? undefined : `Expected ${resourceType} revision`,
    ),
  );

export const ProductSelectionRevisionSchema = revisionOf(productType);
export const VariantSelectionRevisionSchema = revisionOf(variantType);
const AttributeDefinitionSelectionRevisionSchema = revisionOf(attributeDefinitionType);
const ConfigurationUnitSelectionRevisionSchema = revisionOf(configurationUnitType);
export const PackageDefinitionSelectionRevisionSchema = revisionOf(packageDefinitionType);
const ConfigurationDefinitionSelectionRevisionSchema = revisionOf(configurationDefinitionType);
export const SetCompositionSelectionRevisionSchema = revisionOf(setCompositionType);

const sameResource = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: {
    readonly resourceId: string;
    readonly tenantId: string;
  },
) => left.tenantId === right.tenantId && left.resourceId === right.resourceId;
const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) => left.moduleId === right.moduleId && left.resourceType === right.resourceType && sameResource(left, right);

/** A configuration is a complete value for one exact target, not a Configuration Resource. */
export const ProductConfigurationSelectionSchema = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      /** Only present when this choice independently depends on an Attribute Definition. */
      attributeDefinition: Schema.optionalKey(AttributeDefinitionSelectionRevisionSchema),
      choiceKey: choiceKeySchema,
      unit: Schema.optionalKey(ConfigurationUnitSelectionRevisionSchema),
      value: nonEmptyText,
    }),
  ),
  definition: ConfigurationDefinitionSelectionRevisionSchema,
  productRef: ProductRefSchema,
  variantRef: VariantRefSchema,
}).check(
  Schema.makeFilter(({ choices }) =>
    new Set(choices.map(({ choiceKey }) => choiceKey)).size === choices.length
      ? undefined
      : 'Configuration choice keys must be unique',
  ),
);

/** Package quantity remains distinct from purchase-line Quantity. */
const CatalogPackageOptionSelectionSchema = Schema.Struct({
  contentRevision: PackageDefinitionSelectionRevisionSchema,
  optionRef: CatalogResourceRefSchema,
}).check(
  Schema.makeFilter(({ contentRevision, optionRef }) =>
    optionRef.resourceType === 'commerce.catalog.package-definition' &&
    sameResource(optionRef, contentRevision.resourceRef)
      ? undefined
      : 'Package Option must identify its exact Package Definition content revision',
  ),
);

/** Immutable requested product meaning. Parentage and completeness still require owner validation. */
export const CatalogSelectionSchema = Schema.Struct({
  configuration: Schema.optionalKey(ProductConfigurationSelectionSchema),
  packageOption: Schema.optionalKey(CatalogPackageOptionSelectionSchema),
  productRef: ProductRefSchema,
  setComposition: Schema.optionalKey(SetCompositionSelectionRevisionSchema),
  variantRef: VariantRefSchema,
}).check(
  Schema.makeFilter((selection) => {
    const { tenantId } = selection.productRef;
    const refs = [
      selection.variantRef,
      selection.packageOption?.optionRef,
      selection.configuration?.definition.resourceRef,
      selection.setComposition?.resourceRef,
      ...(selection.configuration?.choices.flatMap((choice) => [
        choice.attributeDefinition?.resourceRef,
        choice.unit?.resourceRef,
      ]) ?? []),
    ];
    if (!refs.every((ref) => ref === undefined || ref.tenantId === tenantId)) {
      return 'Selection references must share one Tenant';
    }
    const { configuration } = selection;
    return configuration === undefined ||
      (sameRef(configuration.productRef, selection.productRef) &&
        sameRef(configuration.variantRef, selection.variantRef))
      ? undefined
      : 'Configuration must target the exact selected Product and Variant';
  }),
);
export type CatalogSelection = typeof CatalogSelectionSchema.Type;
