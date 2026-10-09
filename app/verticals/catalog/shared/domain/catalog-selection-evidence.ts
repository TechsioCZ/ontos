import { Match, Schema } from 'effect';

import {
  CatalogResourceRefSchema,
  CatalogRevisionIdSchema,
  CatalogRevisionInstantSchema,
  CatalogRevisionNumberSchema,
} from './catalog-revision-reference.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const choiceKeySchema = nonEmptyText.pipe(Schema.brand('CatalogConfigurationChoiceKey'));
const membershipAttestationIdSchema = nonEmptyText.pipe(Schema.brand('CatalogMembershipAttestationId'));
const setComponentIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('SetComponentId'),
);
const packageDefinitionType = 'commerce.catalog.package-definition';
const productType = 'commerce.catalog.product';
const variantType = 'commerce.catalog.variant';
const attributeDefinitionType = 'commerce.catalog.attribute-definition';
const configurationUnitType = 'commerce.catalog.unit';
const configurationDefinitionType = 'commerce.catalog.configuration-definition';
const setCompositionType = 'commerce.catalog.set-composition';
const productTypeResource = 'commerce.catalog.product-type';
const attributeValueSetType = 'commerce.catalog.attribute-value-set';
const productUnitRuleType = 'commerce.catalog.product-unit';
const productCategoryType = 'commerce.catalog.product-category';

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

/** A line's Quantity is separate from its selected product meaning and package contents. */
export const CatalogSelectionWithQuantitySchema = Schema.Struct({
  quantity: Schema.Struct({ amount: nonEmptyText, unitRef: CatalogResourceRefSchema }),
  selection: CatalogSelectionSchema,
}).check(
  Schema.makeFilter(({ quantity, selection }) =>
    quantity.unitRef.tenantId === selection.productRef.tenantId
      ? undefined
      : 'Quantity must share the Selection Tenant',
  ),
);

/** Closed role vocabulary; every deciding role names the Catalog Resource kind it references. */
export const CatalogSelectionBasisRoles = [
  'PRODUCT',
  'VARIANT',
  'PRODUCT_TYPE',
  'PRODUCT_TYPE_UNTYPED_DECISION',
  'ATTRIBUTE_DEFINITION',
  'INHERITED_VALUE',
  'VARIANT_AXIS',
  'CONFIGURATION_DEFINITION',
  'UNIT',
  'UNIT_CONVERSION',
  'UNIT_RULE',
  'UNIT_TARGET_DIVISIBILITY',
  'PACKAGE_CONTENT',
  'PACKAGE_OPTION_ROLE',
  'SET_COMPOSITION',
  'COMPONENT',
  'CATEGORY',
  'OTHER_CATALOG_FACT',
] as const;
export type CatalogSelectionBasisRole = (typeof CatalogSelectionBasisRoles)[number];

/**
 * Role-specific expected `resourceType`. A hand-built basis cannot borrow another Catalog
 * Resource's identity for a deciding fact. `COMPONENT` and `OTHER_CATALOG_FACT` stay open
 * because their exact source kind is deliberately not fixed by this contract.
 */
const expectedBasisResourceTypes = (role: CatalogSelectionBasisRole): readonly string[] | null =>
  Match.value(role).pipe(
    Match.when('PRODUCT', () => [productType]),
    Match.when('VARIANT', () => [variantType]),
    Match.when('PRODUCT_TYPE', () => [productTypeResource]),
    Match.when('PRODUCT_TYPE_UNTYPED_DECISION', () => [productType]),
    Match.when('ATTRIBUTE_DEFINITION', () => [attributeDefinitionType]),
    Match.when('INHERITED_VALUE', () => [attributeValueSetType]),
    Match.when('VARIANT_AXIS', () => [productType]),
    Match.when('CONFIGURATION_DEFINITION', () => [configurationDefinitionType]),
    Match.whenOr('UNIT', 'UNIT_CONVERSION', () => [configurationUnitType]),
    Match.when('UNIT_RULE', () => [productUnitRuleType]),
    Match.when('UNIT_TARGET_DIVISIBILITY', () => [variantType, packageDefinitionType]),
    Match.whenOr('PACKAGE_CONTENT', 'PACKAGE_OPTION_ROLE', () => [packageDefinitionType]),
    Match.when('SET_COMPOSITION', () => [setCompositionType]),
    Match.when('CATEGORY', () => [productCategoryType]),
    Match.whenOr('COMPONENT', 'OTHER_CATALOG_FACT', () => null),
    Match.exhaustive,
  );

export const CatalogSelectionBasisSchema = Schema.Struct({
  provenance: Schema.optionalKey(Schema.Literal('CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION')),
  role: Schema.Literals([...CatalogSelectionBasisRoles]),
  source: CatalogSelectionRevisionSchema,
  /** Absent for the selected target itself; present for one need in a pinned Set revision. */
  subject: Schema.optionalKey(
    Schema.Struct({
      componentId: setComponentIdSchema,
      composition: SetCompositionSelectionRevisionSchema,
      kind: Schema.Literal('SET_COMPONENT'),
    }),
  ),
}).check(
  Schema.makeFilter(({ role, source, subject }) => {
    if (subject !== undefined && subject.composition.resourceRef.tenantId !== source.resourceRef.tenantId) {
      return 'Component basis and source must share one Tenant';
    }
    const expected = expectedBasisResourceTypes(role);
    return expected !== null && !expected.includes(source.resourceRef.resourceType)
      ? `Basis role ${role} must name a ${expected.join(' or ')} Resource`
      : undefined;
  }),
  Schema.makeFilter(({ provenance, role, subject }) => {
    if (role === 'PRODUCT_TYPE_UNTYPED_DECISION') {
      return provenance === 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' && subject === undefined
        ? undefined
        : 'Untyped Product Type proof requires exact owner decision provenance and no component subject';
    }
    return provenance === undefined ? undefined : 'Only an untyped Product Type decision may carry decision provenance';
  }),
);
export type CatalogSelectionBasis = typeof CatalogSelectionBasisSchema.Type;

/** Role and component scope are part of identity, even when the owner Source revision is equal. */
export const sameCatalogSelectionBasis = (left: CatalogSelectionBasis, right: CatalogSelectionBasis): boolean =>
  left.role === right.role &&
  left.provenance === right.provenance &&
  sameRef(left.source.resourceRef, right.source.resourceRef) &&
  left.source.revision === right.source.revision &&
  left.source.revisionId === right.source.revisionId &&
  (left.subject === undefined
    ? right.subject === undefined
    : right.subject !== undefined &&
      left.subject.componentId === right.subject.componentId &&
      sameRef(left.subject.composition.resourceRef, right.subject.composition.resourceRef) &&
      left.subject.composition.revision === right.subject.composition.revision &&
      left.subject.composition.revisionId === right.subject.composition.revisionId);

export const CatalogSelectionBasisListSchema = Schema.Array(CatalogSelectionBasisSchema).check(
  Schema.makeFilter((basis) =>
    basis.some((entry, index) => basis.slice(index + 1).some((later) => sameCatalogSelectionBasis(entry, later)))
      ? 'Duplicate Catalog basis identity'
      : undefined,
  ),
);

/** Owner-issued membership evidence binds a Variant revision to its Product without changing the request. */
export const CatalogSelectionMembershipSchema = Schema.Struct({
  attestationId: membershipAttestationIdSchema,
  observedAt: CatalogRevisionInstantSchema,
  productRef: ProductRefSchema,
  source: Schema.Literal('CATALOG_OWNER_CURRENT_READ'),
  variant: VariantSelectionRevisionSchema,
}).check(
  Schema.makeFilter(({ productRef, variant }) =>
    productRef.tenantId === variant.resourceRef.tenantId
      ? undefined
      : 'Variant membership must share the Product Tenant',
  ),
);
export type CatalogSelectionMembership = typeof CatalogSelectionMembershipSchema.Type;

const hasExactBasis = (
  basis: readonly (typeof CatalogSelectionBasisSchema.Type)[],
  role: typeof CatalogSelectionBasisSchema.Type.role,
  reference: CatalogSelectionRevision,
): boolean =>
  basis.some(
    ({ role: candidateRole, source, subject }) =>
      subject === undefined &&
      candidateRole === role &&
      sameRef(source.resourceRef, reference.resourceRef) &&
      source.revision === reference.revision &&
      source.revisionId === reference.revisionId,
  );

/** Evidence is a point-in-time assessment, not a guarantee that it remains Current at Order commit. */
const assessmentFields = {
  assessedAt: CatalogRevisionInstantSchema,
  basis: CatalogSelectionBasisListSchema,
  purpose: nonEmptyText,
  selection: CatalogSelectionSchema,
  validUntil: Schema.optionalKey(CatalogRevisionInstantSchema),
};
const hasExclusiveTypeProof = (
  basis: readonly (typeof CatalogSelectionBasisSchema.Type)[],
  productRef: typeof ProductRefSchema.Type,
): boolean => {
  const typed = basis.filter(({ role, subject }) => subject === undefined && role === 'PRODUCT_TYPE').length;
  const untyped = basis.filter(
    ({ provenance, role, source, subject }) =>
      subject === undefined &&
      role === 'PRODUCT_TYPE_UNTYPED_DECISION' &&
      provenance === 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' &&
      sameRef(source.resourceRef, productRef),
  ).length;
  return typed + untyped === 1;
};
export const CatalogSelectionValidEvidenceSchema = Schema.Struct({
  ...assessmentFields,
  membership: CatalogSelectionMembershipSchema,
  status: Schema.Literal('VALID'),
}).check(
  Schema.makeFilter(({ assessedAt, basis, membership, selection, validUntil }) =>
    sameRef(membership.productRef, selection.productRef) &&
    sameRef(membership.variant.resourceRef, selection.variantRef) &&
    membership.observedAt === assessedAt &&
    (validUntil === undefined || validUntil > assessedAt) &&
    basis.every(
      ({ source, subject }) =>
        source.resourceRef.tenantId === selection.productRef.tenantId &&
        (subject === undefined ||
          (selection.setComposition !== undefined &&
            sameRef(subject.composition.resourceRef, selection.setComposition.resourceRef) &&
            subject.composition.revision === selection.setComposition.revision &&
            subject.composition.revisionId === selection.setComposition.revisionId)),
    ) &&
    basis.some(
      ({ role, source, subject }) =>
        subject === undefined && role === 'PRODUCT' && sameRef(source.resourceRef, selection.productRef),
    ) &&
    hasExactBasis(basis, 'VARIANT', membership.variant) &&
    hasExclusiveTypeProof(basis, selection.productRef) &&
    (selection.packageOption === undefined ||
      hasExactBasis(basis, 'PACKAGE_CONTENT', selection.packageOption.contentRevision)) &&
    (selection.setComposition === undefined || hasExactBasis(basis, 'SET_COMPOSITION', selection.setComposition)) &&
    (selection.configuration === undefined ||
      (hasExactBasis(basis, 'CONFIGURATION_DEFINITION', selection.configuration.definition) &&
        selection.configuration.choices.every(
          ({ attributeDefinition, unit }) =>
            (attributeDefinition === undefined || hasExactBasis(basis, 'ATTRIBUTE_DEFINITION', attributeDefinition)) &&
            (unit === undefined || hasExactBasis(basis, 'UNIT', unit)),
        )))
      ? undefined
      : 'VALID evidence requires exact membership, one type proof, and every selected source revision',
  ),
);
const CatalogSelectionInvalidEvidenceSchema = Schema.Struct({
  ...assessmentFields,
  reason: nonEmptyText,
  status: Schema.Literal('INVALID'),
});
const CatalogSelectionIndeterminateEvidenceSchema = Schema.Struct({
  ...assessmentFields,
  reason: nonEmptyText,
  status: Schema.Literal('INDETERMINATE'),
});
export const CatalogSelectionEvidenceSchema = Schema.Union([
  CatalogSelectionValidEvidenceSchema,
  CatalogSelectionInvalidEvidenceSchema,
  CatalogSelectionIndeterminateEvidenceSchema,
]);
export type CatalogSelectionEvidence = typeof CatalogSelectionEvidenceSchema.Type;

/** Operational outcomes cannot be disguised as a product-rule decision. */
export const CatalogSelectionAssessmentResultSchema = Schema.Union([
  CatalogSelectionEvidenceSchema,
  Schema.Struct({ kind: Schema.Literal('NOT_FOUND'), requested: CatalogSelectionSchema }),
  Schema.Struct({ kind: Schema.Literal('PERMISSION_DENIED') }),
  Schema.Struct({ kind: Schema.Literal('CONFLICT'), reason: nonEmptyText }),
  Schema.Struct({ kind: Schema.Literal('UNAVAILABLE'), reason: nonEmptyText }),
]);
export type CatalogSelectionAssessmentResult = typeof CatalogSelectionAssessmentResultSchema.Type;

/** Accepted Order evidence is historical; it is never a Current validation result. */
export const CatalogAcceptedSelectionEvidenceSchema = Schema.Struct({
  acceptedAt: CatalogRevisionInstantSchema,
  acceptedSelection: CatalogSelectionWithQuantitySchema,
  basis: CatalogSelectionBasisListSchema,
  historical: Schema.Literal(true),
  purpose: nonEmptyText,
});
