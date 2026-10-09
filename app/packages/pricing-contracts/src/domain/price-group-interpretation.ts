import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import {
  PriceGroupCompatibilityDecisionSchema,
  PriceGroupCompatibilityEvidenceSchema,
  PriceGroupInstantSchema,
  StablePriceGroupRefSchema,
} from '@app/price-group-catalog-contracts/price-group';
import { Schema } from 'effect';

import { PricingCurrencyCodeSchema } from '../apis/current-supported-currencies.ts';
import { PricePositiveDecimalSchema } from './price-definition.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';

const TenantIdSchema = Schema.String.check(Schema.isUUID());
const ResourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const positiveRevision = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const COMMERCE_CUSTOMER_CONTEXT_MODULE = 'commerce.customer-context' as const;
const PriceGroupBrokenReasonSchema = Schema.Literals(['MISSING', 'RETIRED', 'INCOMPATIBLE']);

export const PriceGroupInterpretationDependencyOwnerSchema = Schema.Literals([
  'COMMERCE_ASSIGNMENT',
  'PRICE_GROUP_COMPATIBILITY',
]);
export type PriceGroupInterpretationDependencyOwner = typeof PriceGroupInterpretationDependencyOwnerSchema.Type;

const CounterpartyRefSchema = Schema.Struct({
  moduleId: Schema.Literal('party.registry'),
  resourceId: ResourceIdSchema,
  resourceType: Schema.Literal('party.registry.counterparty'),
  tenantId: TenantIdSchema,
});

const RetailProfileSchema = Schema.Struct({
  kind: Schema.Literal('RETAIL'),
  moduleId: Schema.Literal(COMMERCE_CUSTOMER_CONTEXT_MODULE),
  resourceId: ResourceIdSchema,
  resourceType: Schema.Literal('commerce.customer-context.retail-customer-profile'),
  tenantId: TenantIdSchema,
});

const CounterpartyProfileSchema = Schema.Struct({
  kind: Schema.Literal('COUNTERPARTY'),
  moduleId: Schema.Literal(COMMERCE_CUSTOMER_CONTEXT_MODULE),
  resourceId: ResourceIdSchema,
  resourceType: Schema.Literal('commerce.customer-context.counterparty-purchasing-profile'),
  tenantId: TenantIdSchema,
});

export const PriceGroupAssignmentProfileSchema = Schema.Union([RetailProfileSchema, CounterpartyProfileSchema]);
export type PriceGroupAssignmentProfile = typeof PriceGroupAssignmentProfileSchema.Type;

const PriceGroupAuthorizationSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL') }),
  Schema.Struct({ counterpartyRef: CounterpartyRefSchema, kind: Schema.Literal('COUNTERPARTY') }),
]);

/** Structural image of Commerce's published request, kept here to avoid a circular project dependency. */
export const PriceGroupAssignmentResolutionRequestSchema = Schema.Struct({
  authorizationSubject: PriceGroupAuthorizationSubjectSchema,
  effectiveAt: PriceGroupInstantSchema,
  profile: PriceGroupAssignmentProfileSchema,
}).check(
  Schema.makeFilter(({ authorizationSubject, profile }) => {
    if (authorizationSubject.kind !== profile.kind) {
      return 'The authorization subject must match the exact customer profile kind';
    }
    return authorizationSubject.kind === 'COUNTERPARTY' &&
      authorizationSubject.counterpartyRef.tenantId !== profile.tenantId
      ? 'The Counterparty authorization subject must belong to the customer profile Tenant'
      : undefined;
  }),
);
export type PriceGroupAssignmentResolutionRequest = typeof PriceGroupAssignmentResolutionRequestSchema.Type;

const AssignmentRefSchema = Schema.Struct({
  moduleId: Schema.Literal(COMMERCE_CUSTOMER_CONTEXT_MODULE),
  resourceId: ResourceIdSchema,
  resourceType: Schema.Literal('commerce.customer-context.customer-price-group-assignment'),
  tenantId: TenantIdSchema,
});

const AssignedResolutionSchema = Schema.TaggedStruct('ASSIGNED', {
  assignmentRef: AssignmentRefSchema,
  assignmentRevision: positiveRevision,
  compatibility: PriceGroupCompatibilityEvidenceSchema,
  effectiveFrom: PriceGroupInstantSchema,
  effectiveTo: Schema.NullOr(PriceGroupInstantSchema),
  priceGroupRef: StablePriceGroupRefSchema,
});
const NoneResolutionSchema = Schema.TaggedStruct('NONE', {});
const BrokenResolutionSchema = Schema.TaggedStruct('BROKEN', {
  assignmentRef: AssignmentRefSchema,
  assignmentRevision: positiveRevision,
  catalogRevision: Schema.NullOr(positiveRevision),
  priceGroupRef: StablePriceGroupRefSchema,
  reason: PriceGroupBrokenReasonSchema,
});
const InconsistentResolutionSchema = Schema.TaggedStruct('INCONSISTENT', {
  currentAssignmentCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(2)),
});

export const PriceGroupAssignmentResolutionSchema = Schema.Union([
  AssignedResolutionSchema,
  NoneResolutionSchema,
  BrokenResolutionSchema,
  InconsistentResolutionSchema,
]);
export type PriceGroupAssignmentResolution = typeof PriceGroupAssignmentResolutionSchema.Type;

/** Structural image of the complete Commerce owner response; no owner proof is reduced to a revision string. */
export const PriceGroupAssignmentResolutionResponseSchema = Schema.Struct({
  effectiveAt: PriceGroupInstantSchema,
  profile: PriceGroupAssignmentProfileSchema,
  resolution: PriceGroupAssignmentResolutionSchema,
});
export type PriceGroupAssignmentResolutionResponse = typeof PriceGroupAssignmentResolutionResponseSchema.Type;

export const PriceGroupInterpretationBasisSchema = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  unitBasis: Schema.Struct({ quantity: PricePositiveDecimalSchema, unitRef: ProductUnitRefSchema }),
}).check(
  Schema.makeFilter(({ catalogSelection, unitBasis }) =>
    catalogSelection.productRef.tenantId === unitBasis.unitRef.tenantId
      ? undefined
      : 'Price Group interpretation must preserve one Tenant across Catalog Selection and Unit basis',
  ),
);
export type PriceGroupInterpretationBasis = typeof PriceGroupInterpretationBasisSchema.Type;

const GuestAssignmentRequestSchema = Schema.Struct({ kind: Schema.Literal('GUEST') });
export const PriceGroupInterpretationAssignmentRequestSchema = Schema.Union([
  GuestAssignmentRequestSchema,
  PriceGroupAssignmentResolutionRequestSchema,
]);
export type PriceGroupInterpretationAssignmentRequest = typeof PriceGroupInterpretationAssignmentRequestSchema.Type;

export const PriceGroupInterpretationInputSchema = Schema.Struct({
  assignmentRequest: PriceGroupInterpretationAssignmentRequestSchema,
  basis: PriceGroupInterpretationBasisSchema,
});
export type PriceGroupInterpretationInput = typeof PriceGroupInterpretationInputSchema.Type;

const PriceGroupSelectorSchema = Schema.Struct({
  kind: Schema.Literal('PRICE_GROUP'),
  priceGroupRef: StablePriceGroupRefSchema,
});
const PriceGroupDiscountAudienceSchema = Schema.Struct({
  kind: Schema.Literal('PRICE_GROUP'),
  priceGroupRef: StablePriceGroupRefSchema,
});

export const AssignedPriceGroupInterpretationSchema = Schema.TaggedStruct('ASSIGNED', {
  assignmentResolution: AssignedResolutionSchema,
  basis: PriceGroupInterpretationBasisSchema,
  compatibilityEvidence: PriceGroupCompatibilityEvidenceSchema,
  discountAudience: PriceGroupDiscountAudienceSchema,
  priceGroupRef: StablePriceGroupRefSchema,
  priceSelector: PriceGroupSelectorSchema,
});

export const NonePriceGroupInterpretationSchema = Schema.TaggedStruct('NONE', {
  assignmentResolution: NoneResolutionSchema,
  basis: PriceGroupInterpretationBasisSchema,
  discountAudience: Schema.Struct({ kind: Schema.Literal('NONE') }),
  priceSelector: Schema.Struct({ kind: Schema.Literal('NO_GROUP') }),
});

export const BrokenPriceGroupInterpretationSchema = Schema.TaggedStruct('BROKEN', {
  assignmentResolution: Schema.Union([AssignedResolutionSchema, BrokenResolutionSchema]),
  basis: PriceGroupInterpretationBasisSchema,
  compatibilityDecision: Schema.optionalKey(PriceGroupCompatibilityDecisionSchema),
  reason: PriceGroupBrokenReasonSchema,
  source: PriceGroupInterpretationDependencyOwnerSchema,
});

export const InconsistentPriceGroupInterpretationSchema = Schema.TaggedStruct('INCONSISTENT', {
  assignmentResolution: InconsistentResolutionSchema,
  basis: PriceGroupInterpretationBasisSchema,
  currentAssignmentCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(2)),
});

export const UnavailablePriceGroupInterpretationSchema = Schema.TaggedStruct('UNAVAILABLE', {
  basis: PriceGroupInterpretationBasisSchema,
  owner: PriceGroupInterpretationDependencyOwnerSchema,
  reason: Schema.String,
});

export const PriceGroupInterpretationUnverifiableReasonSchema = Schema.Literals([
  'ASSIGNMENT_PROFILE_MISMATCH',
  'ASSIGNMENT_SCOPE_MISMATCH',
  'ASSIGNMENT_TIME_MISMATCH',
  'COMPATIBILITY_EVIDENCE_MISMATCH',
  'DEPENDENCY_EVIDENCE_UNVERIFIABLE',
]);
export type PriceGroupInterpretationUnverifiableReason = typeof PriceGroupInterpretationUnverifiableReasonSchema.Type;

export const UnverifiablePriceGroupInterpretationSchema = Schema.TaggedStruct('UNVERIFIABLE', {
  basis: PriceGroupInterpretationBasisSchema,
  owner: PriceGroupInterpretationDependencyOwnerSchema,
  reason: PriceGroupInterpretationUnverifiableReasonSchema,
});

export const PriceGroupInterpretationSchema = Schema.Union([
  AssignedPriceGroupInterpretationSchema,
  NonePriceGroupInterpretationSchema,
  BrokenPriceGroupInterpretationSchema,
  InconsistentPriceGroupInterpretationSchema,
  UnavailablePriceGroupInterpretationSchema,
  UnverifiablePriceGroupInterpretationSchema,
]);
export type PriceGroupInterpretation = typeof PriceGroupInterpretationSchema.Type;
