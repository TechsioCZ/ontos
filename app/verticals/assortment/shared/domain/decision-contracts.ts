import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { ApplicabilityBindingRefSchema } from '../resources/applicability-binding.ts';
import { ClosedAssortmentBoundaryRefSchema } from '../resources/closed-assortment-boundary.ts';
import { RuleRevisionRefSchema } from '../resources/rule-revision.ts';
import { StableRuleRefSchema } from '../resources/stable-rule.ts';

export { ApplicabilityBindingRefSchema as AssortmentApplicabilityBindingRefSchema } from '../resources/applicability-binding.ts';
export { ClosedAssortmentBoundaryRefSchema as AssortmentClosedBoundaryRefSchema } from '../resources/closed-assortment-boundary.ts';
export { StableRuleRefSchema as AssortmentStableRuleRefSchema } from '../resources/stable-rule.ts';

/**
 * Assortment's decision contracts intentionally contain references, not owner
 * records. Catalog, customer context, party registry, and Core remain the
 * authorities for the referenced identities and their revisions.
 */

const NonEmptyTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ResourceIdSchema = NonEmptyTextSchema.pipe(Schema.brand('AssortmentResourceId'));
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('AssortmentTenantId'));
export const AssortmentTenantIdSchema = TenantIdSchema;
export type AssortmentTenantId = typeof TenantIdSchema.Type;
const OwnerModuleIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
  Schema.isMaxLength(200),
).pipe(Schema.brand('AssortmentOwnerModuleId'));
export const AssortmentOwnerModuleIdSchema = OwnerModuleIdSchema;
export type AssortmentOwnerModuleId = typeof OwnerModuleIdSchema.Type;
const ResourceTypeSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
  Schema.isMaxLength(300),
);
const RevisionTokenSchema = NonEmptyTextSchema.check(Schema.isMaxLength(200));
const InstantSchema = Schema.DateTimeUtcFromString;

const sameTenant = (tenantId: string, references: readonly { readonly tenantId: string }[]): boolean =>
  references.every((reference) => reference.tenantId === tenantId);

const evidenceReferenceTenants = (reference: AssortmentEvidenceReference): AssortmentOwnerResourceRef[] => [
  reference.evidenceRef,
  ...(reference.sourceRevision === undefined ? [] : [reference.sourceRevision.sourceRef]),
];

/** A ResourceRef always carries its owner module and resource type. */
export const AssortmentOwnerResourceRefSchema = Schema.Struct({
  moduleId: OwnerModuleIdSchema,
  resourceId: ResourceIdSchema,
  resourceType: ResourceTypeSchema,
  tenantId: TenantIdSchema,
});
export type AssortmentOwnerResourceRef = typeof AssortmentOwnerResourceRefSchema.Type;

export const AssortmentRevisionReferenceSchema = Schema.Struct({
  ownerModuleId: OwnerModuleIdSchema,
  revision: RevisionTokenSchema,
  sourceRef: AssortmentOwnerResourceRefSchema,
}).check(
  Schema.makeFilter((reference) =>
    reference.ownerModuleId === reference.sourceRef.moduleId
      ? undefined
      : 'revision owner must match the source reference owner module',
  ),
);
export type AssortmentRevisionReference = typeof AssortmentRevisionReferenceSchema.Type;

/** Assortment Rule Revision references use the generated owner-local ResourceRef. */
export const AssortmentRuleRevisionReferenceSchema = Schema.Struct({
  ownerModuleId: Schema.Literal('commerce.assortment'),
  revision: RevisionTokenSchema,
  sourceRef: RuleRevisionRefSchema,
});

export const AssortmentEvidenceReferenceSchema = Schema.Struct({
  evidenceRef: AssortmentOwnerResourceRefSchema,
  ownerModuleId: OwnerModuleIdSchema,
  sourceRevision: Schema.optionalKey(AssortmentRevisionReferenceSchema),
}).check(
  Schema.makeFilter((reference) => {
    if (reference.ownerModuleId !== reference.evidenceRef.moduleId) {
      return 'evidence owner must match the evidence reference owner module';
    }
    return reference.sourceRevision !== undefined &&
      reference.sourceRevision.sourceRef.tenantId !== reference.evidenceRef.tenantId
      ? 'evidence revision must match the evidence reference tenant'
      : undefined;
  }),
);
export type AssortmentEvidenceReference = typeof AssortmentEvidenceReferenceSchema.Type;

/**
 * Catalog's module contract identity is intentionally unresolved here. These
 * branded wrappers preserve an exact owner-qualified ResourceRef without
 * inventing a Catalog deployment/module or private resource type.
 */
const catalogRefOf = (brand: string) => AssortmentOwnerResourceRefSchema.pipe(Schema.brand(brand));

export const CatalogProductRefSchema = catalogRefOf('AssortmentCatalogProductRef');
export type CatalogProductRef = typeof CatalogProductRefSchema.Type;
export const CatalogVariantRefSchema = catalogRefOf('AssortmentCatalogVariantRef');
export const CatalogCategoryRefSchema = catalogRefOf('AssortmentCatalogCategoryRef');
export const CatalogPackageOptionRefSchema = catalogRefOf('AssortmentCatalogPackageOptionRef');

export const CatalogPackageContentRevisionReferenceSchema = AssortmentRevisionReferenceSchema.pipe(
  Schema.brand('AssortmentCatalogPackageContentRevisionReference'),
);

export const CatalogSetCompositionRevisionReferenceSchema = AssortmentRevisionReferenceSchema.pipe(
  Schema.brand('AssortmentCatalogSetCompositionRevisionReference'),
);

export const CatalogProductConfigurationDefinitionReferenceSchema = AssortmentRevisionReferenceSchema.pipe(
  Schema.brand('AssortmentCatalogProductConfigurationDefinitionReference'),
);

const JsonValueSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
);

export const AssortmentProductConfigurationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('NONE') }),
  Schema.Struct({
    definitionRevision: CatalogProductConfigurationDefinitionReferenceSchema,
    kind: Schema.Literal('CONFIGURED'),
    value: Schema.Record(Schema.String, JsonValueSchema),
  }).check(
    Schema.makeFilter((configuration) =>
      Object.keys(configuration.value).length > 0 ? undefined : 'configured Product Configuration must be complete',
    ),
  ),
]);

const CatalogSelectionFields = {
  configuration: AssortmentProductConfigurationSchema,
  packageOption: Schema.optionalKey(
    Schema.Struct({
      contentRevision: CatalogPackageContentRevisionReferenceSchema,
      packageOptionRef: CatalogPackageOptionRefSchema,
    }),
  ),
  productRef: CatalogProductRefSchema,
  variantRef: CatalogVariantRefSchema,
} as const;

/** Exact, immutable Catalog meaning used by one purchase constituent. */
export const AssortmentCatalogSelectionSchema = Schema.Union([
  Schema.Struct({
    ...CatalogSelectionFields,
    variantKind: Schema.Literal('ATOMIC'),
  }),
  Schema.Struct({
    ...CatalogSelectionFields,
    setCompositionRevision: CatalogSetCompositionRevisionReferenceSchema,
    variantKind: Schema.Literal('SET'),
  }),
]).check(
  Schema.makeFilter((selection) => {
    const references = [
      selection.productRef,
      selection.variantRef,
      ...(selection.configuration.kind === 'CONFIGURED' ? [selection.configuration.definitionRevision.sourceRef] : []),
      ...(selection.packageOption === undefined
        ? []
        : [selection.packageOption.packageOptionRef, selection.packageOption.contentRevision.sourceRef]),
      ...(selection.variantKind === 'SET' ? [selection.setCompositionRevision.sourceRef] : []),
    ];
    return references.every((reference) => reference.tenantId === selection.productRef.tenantId)
      ? undefined
      : 'Catalog Selection references must share one tenant';
  }),
);
export type AssortmentCatalogSelection = typeof AssortmentCatalogSelectionSchema.Type;
const catalogSelectionEquivalence = Schema.toEquivalence(AssortmentCatalogSelectionSchema);

const selectionReferences = (selection: AssortmentCatalogSelection): AssortmentOwnerResourceRef[] => [
  selection.productRef,
  selection.variantRef,
  ...(selection.configuration.kind === 'CONFIGURED' ? [selection.configuration.definitionRevision.sourceRef] : []),
  ...(selection.packageOption === undefined
    ? []
    : [selection.packageOption.packageOptionRef, selection.packageOption.contentRevision.sourceRef]),
  ...(selection.variantKind === 'SET' ? [selection.setCompositionRevision.sourceRef] : []),
];

export const AssortmentCatalogSelectorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('ALL') }),
  Schema.Struct({ categoryRef: CatalogCategoryRefSchema, kind: Schema.Literal('CATEGORY') }),
  Schema.Struct({ kind: Schema.Literal('PRODUCT'), productRef: CatalogProductRefSchema }),
  Schema.Struct({ kind: Schema.Literal('VARIANT'), variantRef: CatalogVariantRefSchema }),
  Schema.Struct({ kind: Schema.Literal('PACKAGE_OPTION'), packageOptionRef: CatalogPackageOptionRefSchema }),
]);
export type AssortmentCatalogSelector = typeof AssortmentCatalogSelectorSchema.Type;
export const AssortmentCatalogSelectorKindSchema = Schema.Literals([
  'ALL',
  'CATEGORY',
  'PRODUCT',
  'VARIANT',
  'PACKAGE_OPTION',
]);
export type AssortmentCatalogSelectorKind = typeof AssortmentCatalogSelectorKindSchema.Type;

export const AssortmentDecisionPurposeSchema = Schema.Literals(['VISIBILITY', 'PURCHASE']);
export type AssortmentDecisionPurpose = typeof AssortmentDecisionPurposeSchema.Type;
export const AssortmentEffectSchema = Schema.Literals(['ALLOW', 'DENY']);

const selectorKindOf = (selector: AssortmentCatalogSelector): AssortmentCatalogSelectorKind => selector.kind;

/** Immutable Rule Revision meaning. Commercial Scope and lifecycle belong to a Binding. */
export const AssortmentRuleRevisionSchema = Schema.Struct({
  decisionPurpose: AssortmentDecisionPurposeSchema,
  effect: AssortmentEffectSchema,
  revision: AssortmentRuleRevisionReferenceSchema,
  selector: AssortmentCatalogSelectorSchema,
}).check(
  Schema.makeFilter((revision) => {
    const kind = selectorKindOf(revision.selector);
    return revision.decisionPurpose === 'VISIBILITY' && (kind === 'VARIANT' || kind === 'PACKAGE_OPTION')
      ? 'VARIANT and PACKAGE_OPTION selectors are invalid for VISIBILITY'
      : undefined;
  }),
);

/** The shared commercial applicability value used by Bindings and Boundaries. */
export const AssortmentCommercialScopeSchema = Schema.Struct({
  channelRef: AssortmentOwnerResourceRefSchema,
  commerceMarketRef: Schema.optionalKey(AssortmentOwnerResourceRefSchema),
  sellingLegalEntityRef: AssortmentOwnerResourceRefSchema,
  storefrontRef: Schema.optionalKey(AssortmentOwnerResourceRefSchema),
});
export type AssortmentCommercialScope = typeof AssortmentCommercialScopeSchema.Type;

const RetailCustomerProfileRefSchema = AssortmentOwnerResourceRefSchema.check(
  Schema.makeFilter((reference) =>
    reference.moduleId === 'commerce.customer-context' &&
    reference.resourceType === 'commerce.customer-context.retail-customer-profile'
      ? undefined
      : 'reference must identify a Commerce Retail Customer Profile',
  ),
);
const CounterpartyRefSchema = AssortmentOwnerResourceRefSchema.check(
  Schema.makeFilter((reference) =>
    reference.moduleId === 'party.registry' && reference.resourceType === 'party.registry.counterparty'
      ? undefined
      : 'reference must identify a Party Registry Counterparty',
  ),
);

export const AssortmentPurchasingSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL_CUSTOMER_PROFILE'), profileRef: RetailCustomerProfileRefSchema }),
  Schema.Struct({ counterpartyRef: CounterpartyRefSchema, kind: Schema.Literal('COUNTERPARTY') }),
]);
export type AssortmentPurchasingSubject = typeof AssortmentPurchasingSubjectSchema.Type;

export const AssortmentGuestPurchaseContextSchema = Schema.Struct({
  guestEvidence: AssortmentEvidenceReferenceSchema,
  kind: Schema.Literal('GUEST_PURCHASE_CONTEXT'),
}).check(
  Schema.makeFilter((context) =>
    sameTenant(context.guestEvidence.evidenceRef.tenantId, evidenceReferenceTenants(context.guestEvidence))
      ? undefined
      : 'Guest evidence references must share one tenant',
  ),
);
export type AssortmentGuestPurchaseContext = typeof AssortmentGuestPurchaseContextSchema.Type;

export const AssortmentDecisionSubjectSchema = Schema.Union([
  AssortmentGuestPurchaseContextSchema,
  Schema.Struct({ kind: Schema.Literal('IDENTIFIED'), subject: AssortmentPurchasingSubjectSchema }),
]);
export type AssortmentDecisionSubject = typeof AssortmentDecisionSubjectSchema.Type;

const decisionSubjectReferences = (subject: AssortmentDecisionSubject): AssortmentOwnerResourceRef[] => {
  if (subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    return evidenceReferenceTenants(subject.guestEvidence);
  }
  return [
    subject.subject.kind === 'RETAIL_CUSTOMER_PROFILE' ? subject.subject.profileRef : subject.subject.counterpartyRef,
  ];
};

/** Principal is optional actor context and deliberately absent from subject unions. */

export const AssortmentTrustedCommerceContextSchema = Schema.Struct({
  channelRef: AssortmentOwnerResourceRefSchema,
  commerceMarketRef: Schema.optionalKey(AssortmentOwnerResourceRefSchema),
  operationTime: InstantSchema,
  sellingLegalEntityRef: AssortmentOwnerResourceRefSchema,
  storefrontRef: Schema.optionalKey(AssortmentOwnerResourceRefSchema),
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter((context) =>
    sameTenant(context.tenantId, [
      context.channelRef,
      context.sellingLegalEntityRef,
      ...(context.commerceMarketRef === undefined ? [] : [context.commerceMarketRef]),
      ...(context.storefrontRef === undefined ? [] : [context.storefrontRef]),
    ])
      ? undefined
      : 'trusted Commerce context references must share the context tenant',
  ),
);
export type AssortmentTrustedCommerceContext = typeof AssortmentTrustedCommerceContextSchema.Type;

export const AssortmentPurchaseConstituentSchema = Schema.Struct({
  catalogSelection: AssortmentCatalogSelectionSchema,
  role: Schema.Literals(['TOP_LEVEL', 'REQUIRED_COMPONENT']),
});
export type AssortmentPurchaseConstituent = typeof AssortmentPurchaseConstituentSchema.Type;

const RequiredComponentConstituentSchema = AssortmentPurchaseConstituentSchema.check(
  Schema.makeFilter((constituent) =>
    constituent.role === 'REQUIRED_COMPONENT' && constituent.catalogSelection.variantKind === 'ATOMIC'
      ? undefined
      : 'required Set components must be independent non-Set constituents',
  ),
);

/** Catalog-owned pinned composition; it does not merge Candidates or outcomes. */
export const AssortmentSetPurchaseCompositionSchema = Schema.Struct({
  requiredComponents: Schema.Array(RequiredComponentConstituentSchema).check(Schema.isMinLength(1)),
  setCompositionRevision: CatalogSetCompositionRevisionReferenceSchema,
}).check(
  Schema.makeFilter((composition) => {
    const selections = composition.requiredComponents.map((component) => component.catalogSelection);
    const hasDuplicate = selections.some((selection, index) =>
      selections.slice(0, index).some((previous) => catalogSelectionEquivalence(previous, selection)),
    );
    if (hasDuplicate) {
      return 'Set constituents must have independent identities';
    }
    const references = composition.requiredComponents.flatMap((component) =>
      selectionReferences(component.catalogSelection),
    );
    return sameTenant(composition.setCompositionRevision.sourceRef.tenantId, references)
      ? undefined
      : 'Set composition references must share one tenant';
  }),
);
export type AssortmentSetPurchaseComposition = typeof AssortmentSetPurchaseCompositionSchema.Type;

export const AssortmentVisibilityRequestSchema = Schema.Struct({
  decisionPurpose: Schema.Literal('VISIBILITY'),
  principalRef: Schema.optionalKey(PrincipalRefSchema),
  productRef: CatalogProductRefSchema,
  subject: AssortmentDecisionSubjectSchema,
  trustedContext: AssortmentTrustedCommerceContextSchema,
}).check(
  Schema.makeFilter((request) => {
    const references = [
      request.productRef,
      ...decisionSubjectReferences(request.subject),
      ...(request.principalRef === undefined ? [] : [{ tenantId: request.principalRef.tenantId }]),
    ];
    return sameTenant(request.trustedContext.tenantId, references)
      ? undefined
      : 'VISIBILITY request references must share the trusted context tenant';
  }),
);
export type AssortmentVisibilityRequest = typeof AssortmentVisibilityRequestSchema.Type;

export const AssortmentPurchaseRequestSchema = Schema.Struct({
  constituent: AssortmentPurchaseConstituentSchema,
  decisionPurpose: Schema.Literal('PURCHASE'),
  principalRef: Schema.optionalKey(PrincipalRefSchema),
  setComposition: Schema.optionalKey(AssortmentSetPurchaseCompositionSchema),
  subject: AssortmentDecisionSubjectSchema,
  trustedContext: AssortmentTrustedCommerceContextSchema,
}).check(
  Schema.makeFilter((request) => {
    const isSet = request.constituent.catalogSelection.variantKind === 'SET';
    const references = [
      ...selectionReferences(request.constituent.catalogSelection),
      ...decisionSubjectReferences(request.subject),
      ...(request.principalRef === undefined ? [] : [{ tenantId: request.principalRef.tenantId }]),
      ...(request.setComposition === undefined
        ? []
        : [
            request.setComposition.setCompositionRevision.sourceRef,
            ...request.setComposition.requiredComponents.flatMap((component) =>
              selectionReferences(component.catalogSelection),
            ),
          ]),
    ];
    if (!sameTenant(request.trustedContext.tenantId, references)) {
      return 'PURCHASE request references must share the trusted context tenant';
    }
    if (
      request.constituent.role === 'REQUIRED_COMPONENT' &&
      request.constituent.catalogSelection.variantKind !== 'ATOMIC'
    ) {
      return 'a required-component request must target an atomic Catalog Selection';
    }
    if (isSet !== (request.setComposition !== undefined)) {
      return isSet
        ? 'a Set constituent requires its pinned Set composition'
        : 'a non-Set constituent cannot carry Set composition';
    }
    if (
      isSet &&
      request.setComposition !== undefined &&
      (request.constituent.catalogSelection.variantKind !== 'SET' ||
        request.constituent.catalogSelection.setCompositionRevision.ownerModuleId !==
          request.setComposition.setCompositionRevision.ownerModuleId ||
        request.constituent.catalogSelection.setCompositionRevision.revision !==
          request.setComposition.setCompositionRevision.revision ||
        request.constituent.catalogSelection.setCompositionRevision.sourceRef.moduleId !==
          request.setComposition.setCompositionRevision.sourceRef.moduleId ||
        request.constituent.catalogSelection.setCompositionRevision.sourceRef.resourceId !==
          request.setComposition.setCompositionRevision.sourceRef.resourceId ||
        request.constituent.catalogSelection.setCompositionRevision.sourceRef.resourceType !==
          request.setComposition.setCompositionRevision.sourceRef.resourceType ||
        request.constituent.catalogSelection.setCompositionRevision.sourceRef.tenantId !==
          request.setComposition.setCompositionRevision.sourceRef.tenantId)
    ) {
      return 'Set composition revision must match the top-level Catalog Selection';
    }
    return true;
  }),
);
export type AssortmentPurchaseRequest = typeof AssortmentPurchaseRequestSchema.Type;
export const AssortmentDecisionRequestSchema = Schema.Union([
  AssortmentVisibilityRequestSchema,
  AssortmentPurchaseRequestSchema,
]);
export type AssortmentDecisionRequest = typeof AssortmentDecisionRequestSchema.Type;

const CustomerGroupRefSchema = AssortmentOwnerResourceRefSchema.check(
  Schema.makeFilter((reference) =>
    reference.moduleId === 'commerce.customer-context' &&
    reference.resourceType === 'commerce.customer-context.customer-group'
      ? undefined
      : 'reference must identify a Commerce Customer Group',
  ),
);

const BindingAudienceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('SHARED') }),
  Schema.Struct({ groupRef: CustomerGroupRefSchema, kind: Schema.Literal('COMMERCE_CUSTOMER_GROUP') }),
  Schema.Struct({ kind: Schema.Literal('SUBJECT'), subject: AssortmentPurchasingSubjectSchema }),
]);

/** One ordinary resolver participant: Binding + exact immutable Rule Revision. */
export const AssortmentCandidateSchema = Schema.Struct({
  audience: BindingAudienceSchema,
  bindingRef: ApplicabilityBindingRefSchema,
  commercialScope: AssortmentCommercialScopeSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  effect: AssortmentEffectSchema,
  ruleRevision: AssortmentRuleRevisionReferenceSchema,
  selector: AssortmentCatalogSelectorSchema,
  stableRuleRef: Schema.optionalKey(StableRuleRefSchema),
}).check(
  Schema.makeFilter((candidate) => {
    const kind = selectorKindOf(candidate.selector);
    return candidate.decisionPurpose === 'VISIBILITY' && (kind === 'VARIANT' || kind === 'PACKAGE_OPTION')
      ? 'VISIBILITY Candidates reject VARIANT and PACKAGE_OPTION selectors'
      : undefined;
  }),
);
export type AssortmentCandidate = typeof AssortmentCandidateSchema.Type;

export const AssortmentFactCurrentnessEvidenceSchema = Schema.Struct({
  factRef: AssortmentOwnerResourceRefSchema,
  proof: AssortmentEvidenceReferenceSchema,
  state: Schema.Literals(['CURRENT', 'STALE']),
});
export type AssortmentFactCurrentnessEvidence = typeof AssortmentFactCurrentnessEvidenceSchema.Type;

export const AssortmentSetCompletenessEvidenceSchema = Schema.Struct({
  predicate: NonEmptyTextSchema,
  proof: AssortmentEvidenceReferenceSchema,
  scope: NonEmptyTextSchema,
  state: Schema.Literals(['COMPLETE', 'UNVERIFIABLE', 'STALE']),
});
export type AssortmentSetCompletenessEvidence = typeof AssortmentSetCompletenessEvidenceSchema.Type;

export const AssortmentClosedBoundarySchema = Schema.Struct({
  admissionSet: Schema.Array(AssortmentCatalogSelectorSchema),
  boundaryRef: ClosedAssortmentBoundaryRefSchema,
  commercialScope: AssortmentCommercialScopeSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  effectiveFrom: InstantSchema,
  effectiveTo: Schema.optionalKey(InstantSchema),
  subject: AssortmentPurchasingSubjectSchema,
}).check(
  Schema.makeFilter((boundary) => {
    const hasPurchaseOnlySelector = boundary.admissionSet.some(
      (selector) => selector.kind === 'VARIANT' || selector.kind === 'PACKAGE_OPTION',
    );
    return boundary.decisionPurpose === 'VISIBILITY' && hasPurchaseOnlySelector
      ? 'VISIBILITY Boundaries reject VARIANT and PACKAGE_OPTION admission selectors'
      : undefined;
  }),
);
export type AssortmentClosedBoundary = typeof AssortmentClosedBoundarySchema.Type;

export const AssortmentBoundaryPathSchema = Schema.Union([
  Schema.Struct({
    completeness: AssortmentSetCompletenessEvidenceSchema,
    kind: Schema.Literal('NO_APPLICABLE_BOUNDARY'),
  }),
  Schema.Struct({
    admitted: Schema.Boolean,
    boundary: AssortmentClosedBoundarySchema,
    completeness: AssortmentSetCompletenessEvidenceSchema,
    kind: Schema.Literal('UNIQUE_MAXIMAL_BOUNDARY'),
  }),
  Schema.Struct({
    boundaries: Schema.Array(AssortmentClosedBoundarySchema).check(Schema.isMinLength(2)),
    completeness: AssortmentSetCompletenessEvidenceSchema,
    kind: Schema.Literal('BOUNDARY_CONFIGURATION_CONFLICT'),
  }),
]);
export type AssortmentBoundaryPath = typeof AssortmentBoundaryPathSchema.Type;

export const AssortmentDecisionOutcomeSchema = Schema.Literals(['ELIGIBLE', 'INELIGIBLE', 'INDETERMINATE']);
export type AssortmentDecisionOutcome = typeof AssortmentDecisionOutcomeSchema.Type;

export const AssortmentSafeReasonCodeSchema = Schema.Literals([
  'BOUNDARY_EXCLUDED',
  'RULE_DENIED',
  'CONFIGURATION_CONFLICT',
  'MISSING_CONFIGURATION',
  'DEPENDENCY_UNAVAILABLE',
  'CURRENTNESS_UNCERTAIN',
  'RETRY_EXHAUSTED',
]);
export type AssortmentSafeReasonCode = typeof AssortmentSafeReasonCodeSchema.Type;

const assortmentConfigurationConflictFields = {
  code: Schema.Literal('CONFIGURATION_CONFLICT'),
  conflictKind: Schema.Literals(['BOUNDARY', 'ORDINARY']),
  safeReasonCode: Schema.Literal('CONFIGURATION_CONFLICT'),
} as const;
const AssortmentConfigurationConflictErrorSchema = Schema.TaggedStruct(
  'AssortmentConfigurationConflictError',
  assortmentConfigurationConflictFields,
);
export const AssortmentConfigurationConflictError = Schema.TaggedError<
  typeof AssortmentConfigurationConflictErrorSchema.Type
>()('AssortmentConfigurationConflictError', assortmentConfigurationConflictFields);

const assortmentMissingConfigurationFields = {
  code: Schema.Literal('MISSING_CONFIGURATION'),
  safeReasonCode: Schema.Literal('MISSING_CONFIGURATION'),
} as const;
const AssortmentMissingConfigurationErrorSchema = Schema.TaggedStruct(
  'AssortmentMissingConfigurationError',
  assortmentMissingConfigurationFields,
);
export const AssortmentMissingConfigurationError = Schema.TaggedError<
  typeof AssortmentMissingConfigurationErrorSchema.Type
>()('AssortmentMissingConfigurationError', assortmentMissingConfigurationFields);

const assortmentDependencyFailureFields = {
  code: Schema.Literal('DEPENDENCY_FAILURE'),
  ownerModuleId: OwnerModuleIdSchema,
  retryable: Schema.Literal(true),
  safeReasonCode: Schema.Literal('DEPENDENCY_UNAVAILABLE'),
} as const;
const AssortmentDependencyFailureErrorSchema = Schema.TaggedStruct(
  'AssortmentDependencyFailureError',
  assortmentDependencyFailureFields,
);
export const AssortmentDependencyFailureError = Schema.TaggedError<
  typeof AssortmentDependencyFailureErrorSchema.Type
>()('AssortmentDependencyFailureError', assortmentDependencyFailureFields);

const assortmentRetryExhaustedFields = {
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  code: Schema.Literal('RETRY_EXHAUSTED'),
  maxAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  safeReasonCode: Schema.Literal('RETRY_EXHAUSTED'),
} as const;
const AssortmentRetryExhaustedErrorBaseSchema = Schema.TaggedStruct(
  'AssortmentRetryExhaustedError',
  assortmentRetryExhaustedFields,
);
const retryExhaustionIsExact = (error: typeof AssortmentRetryExhaustedErrorBaseSchema.Type) =>
  error.attempts === error.maxAttempts ? undefined : 'retry attempts must equal maxAttempts';
export const AssortmentRetryExhaustedErrorSchema = AssortmentRetryExhaustedErrorBaseSchema.check(
  Schema.makeFilter(retryExhaustionIsExact),
);
export const AssortmentRetryExhaustedError = Schema.TaggedError<typeof AssortmentRetryExhaustedErrorBaseSchema.Type>()(
  'AssortmentRetryExhaustedError',
  assortmentRetryExhaustedFields,
);

export const AssortmentDecisionFailureSchema = Schema.Union([
  AssortmentConfigurationConflictError,
  AssortmentMissingConfigurationError,
  AssortmentDependencyFailureError,
  AssortmentRetryExhaustedErrorSchema,
]);

/** Public response: safe reason only, never Boundary/Candidate/evidence internals. */
export const AssortmentPublicDecisionResponseSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal('ELIGIBLE'),
    retryable: Schema.Literal(false),
  }),
  Schema.Struct({
    outcome: Schema.Literal('INELIGIBLE'),
    retryable: Schema.Literal(false),
    safeReasonCode: Schema.Literals(['BOUNDARY_EXCLUDED', 'RULE_DENIED']),
  }),
  Schema.Struct({
    outcome: Schema.Literal('INDETERMINATE'),
    retryable: Schema.Literal(true),
    safeReasonCode: Schema.Literals(['DEPENDENCY_UNAVAILABLE', 'CURRENTNESS_UNCERTAIN']),
  }),
  Schema.Struct({
    outcome: Schema.Literal('INDETERMINATE'),
    retryable: Schema.Literal(false),
    safeReasonCode: Schema.Literals(['CONFIGURATION_CONFLICT', 'MISSING_CONFIGURATION', 'RETRY_EXHAUSTED']),
  }),
]);
export type AssortmentPublicDecisionResponse = typeof AssortmentPublicDecisionResponseSchema.Type;

/** Governed explanation/evidence is an owner-internal contract, not a public response. */
export const AssortmentDecisionEvidenceSchema = Schema.Struct({
  boundaryPath: Schema.optionalKey(AssortmentBoundaryPathSchema),
  candidates: Schema.optionalKey(Schema.Array(AssortmentCandidateSchema)),
  factCurrentness: Schema.Array(AssortmentFactCurrentnessEvidenceSchema),
  operationTime: InstantSchema,
  setCompleteness: Schema.Array(AssortmentSetCompletenessEvidenceSchema),
  subject: AssortmentDecisionSubjectSchema,
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('PRODUCT'), productRef: CatalogProductRefSchema }),
    Schema.Struct({ kind: Schema.Literal('CATALOG_SELECTION'), selection: AssortmentCatalogSelectionSchema }),
  ]),
  trustedContext: AssortmentTrustedCommerceContextSchema,
});
export type AssortmentDecisionEvidence = typeof AssortmentDecisionEvidenceSchema.Type;

export const AssortmentGovernedDecisionSchema = Schema.Union([
  Schema.Struct({ evidence: AssortmentDecisionEvidenceSchema, outcome: Schema.Literal('ELIGIBLE') }),
  Schema.Struct({ evidence: AssortmentDecisionEvidenceSchema, outcome: Schema.Literal('INELIGIBLE') }),
  Schema.Struct({
    evidence: Schema.optionalKey(AssortmentDecisionEvidenceSchema),
    failure: AssortmentDecisionFailureSchema,
    outcome: Schema.Literal('INDETERMINATE'),
  }),
]);
export type AssortmentGovernedDecision = typeof AssortmentGovernedDecisionSchema.Type;

export type AssortmentConstituentDecision = Readonly<{
  constituent: AssortmentPurchaseConstituent;
  outcome: AssortmentDecisionOutcome;
}>;

/**
 * Compose only outcomes that were actually evaluated. In particular, this
 * function never fabricates sibling results after an authoritative INELIGIBLE.
 */
export const composeAssortmentPurchaseOutcome = (
  decisions: readonly AssortmentConstituentDecision[],
): AssortmentDecisionOutcome => {
  if (decisions.length === 0) {
    return 'INDETERMINATE';
  }
  if (decisions.some((decision) => decision.outcome === 'INELIGIBLE')) {
    return 'INELIGIBLE';
  }
  if (decisions.some((decision) => decision.outcome === 'INDETERMINATE')) {
    return 'INDETERMINATE';
  }
  return 'ELIGIBLE';
};
