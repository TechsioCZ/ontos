/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema -- Public cross-module ResourceRef wire contracts remain compatible with generated refs and encode explicit null timeline/catalog states; expires: 2027-03-01. */
import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { CustomerPriceGroupAssignmentRefSchema } from '../resources/customer-price-group-assignment.ts';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import { CounterpartyRefSchema } from './access-contract.ts';
import { CommerceCustomerProfileRefSchema } from './profile-decisions.ts';

const BoundedIdentifierSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
export const PriceGroupReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
export const PriceGroupRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

const isCanonicalPriceGroupInstant = (value: string): boolean => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value;
};
const PriceGroupInstantSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    isCanonicalPriceGroupInstant(value)
      ? undefined
      : 'timestamp must be one canonical UTC instant with millisecond precision',
  ),
).pipe(
  Schema.decodeTo(
    Schema.toType(Schema.DateTimeUtc),
    (function priceGroupInstantSchemaGetter() {
      return {
        decode: SchemaGetter.transform(DateTime.makeUnsafe),
        encode: SchemaGetter.transform(DateTime.formatIso),
      };
    })(),
  ),
);

/** Browser-safe representation of one trusted UTC instant. */
export const PriceGroupInstantJsonSchema = Schema.toEncoded(PriceGroupInstantSchema);
export type PriceGroupInstant = typeof PriceGroupInstantJsonSchema.Type;

export const isPriceGroupInstantBefore = (requested: PriceGroupInstant, trustedNow: PriceGroupInstant): boolean =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(requested)) < DateTime.toEpochMillis(DateTime.makeUnsafe(trustedNow));

/**
 * The reference deliberately does not fix Pricing's future module/resource identifiers. #334 owns
 * that contract. The injected catalog port must recognize the reference as Pricing-owned before it
 * can be persisted or returned as ASSIGNED.
 */
export const PriceGroupRefSchema = Schema.Struct({
  moduleId: BoundedIdentifierSchema,
  resourceId: BoundedIdentifierSchema,
  resourceType: BoundedIdentifierSchema,
  tenantId: Schema.String.check(Schema.isUUID()),
});
export type PriceGroupRef = typeof PriceGroupRefSchema.Type;

export const CommerceCustomerProfileTargetSchema = CommerceCustomerProfileRefSchema;
export type CommerceCustomerProfileTarget = typeof CommerceCustomerProfileTargetSchema.Type;

export const PriceGroupAuthorizationSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL') }),
  Schema.Struct({ counterpartyRef: CounterpartyRefSchema, kind: Schema.Literal('COUNTERPARTY') }),
]);
export type PriceGroupAuthorizationSubject = typeof PriceGroupAuthorizationSubjectSchema.Type;

export const isPriceGroupAuthorizationSubjectCompatible = (
  profile: CommerceCustomerProfileTarget,
  subject: PriceGroupAuthorizationSubject,
): boolean =>
  profile.kind === subject.kind && (subject.kind === 'RETAIL' || subject.counterpartyRef.tenantId === profile.tenantId);

/** Staff-only Retail mutation target. Counterparty mutations use separate Permission-bound Actions. */
export const RetailPriceGroupProfileTargetSchema = Schema.Struct({
  kind: Schema.Literal('RETAIL'),
  ...RetailCustomerProfileRefSchema.fields,
});

export const CounterpartyPriceGroupProfileTargetSchema = Schema.Struct({
  kind: Schema.Literal('COUNTERPARTY'),
  ...CounterpartyPurchasingProfileRefSchema.fields,
});

const PriceGroupCompatibilityIdentitySchema = Schema.Struct({
  catalogRevision: PriceGroupRevisionSchema,
  contractId: BoundedIdentifierSchema,
  contractRevision: PriceGroupRevisionSchema,
  definitionRevision: PriceGroupRevisionSchema,
});
export type PriceGroupCompatibilityIdentity = typeof PriceGroupCompatibilityIdentitySchema.Type;

const CustomerPriceGroupAssignmentStateSchema = Schema.Literals(['ACTIVE', 'CANCELLED']);

export const CustomerPriceGroupAssignmentSchema = Schema.Struct({
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  compatibility: PriceGroupCompatibilityIdentitySchema,
  effectiveFrom: PriceGroupInstantJsonSchema,
  effectiveTo: Schema.NullOr(PriceGroupInstantJsonSchema),
  priceGroupRef: PriceGroupRefSchema,
  profile: CommerceCustomerProfileTargetSchema,
  reason: PriceGroupReasonSchema,
  recordedAt: PriceGroupInstantJsonSchema,
  revision: PriceGroupRevisionSchema,
  state: CustomerPriceGroupAssignmentStateSchema,
}).check(
  Schema.makeFilter((assignment) =>
    assignment.state === 'CANCELLED' ||
    assignment.effectiveTo === null ||
    assignment.effectiveTo > assignment.effectiveFrom
      ? undefined
      : [{ issue: 'effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
  ),
);
export type CustomerPriceGroupAssignment = typeof CustomerPriceGroupAssignmentSchema.Type;

const PriceGroupCatalogOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('USABLE', {
    compatibility: PriceGroupCompatibilityIdentitySchema,
    priceGroupRef: PriceGroupRefSchema,
  }),
  Schema.TaggedStruct('MISSING', {}),
  Schema.TaggedStruct('RETIRED', { catalogRevision: PriceGroupRevisionSchema }),
  Schema.TaggedStruct('INCOMPATIBLE', {
    catalogRevision: PriceGroupRevisionSchema,
    contractId: BoundedIdentifierSchema,
  }),
  Schema.TaggedStruct('UNUSABLE', {
    catalogRevision: PriceGroupRevisionSchema,
    reasonCode: BoundedIdentifierSchema,
  }),
]);
export type PriceGroupCatalogOutcome = typeof PriceGroupCatalogOutcomeSchema.Type;

const AssignedResolutionSchema = Schema.TaggedStruct('ASSIGNED', {
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  assignmentRevision: PriceGroupRevisionSchema,
  compatibility: PriceGroupCompatibilityIdentitySchema,
  effectiveFrom: PriceGroupInstantJsonSchema,
  effectiveTo: Schema.NullOr(PriceGroupInstantJsonSchema),
  priceGroupRef: PriceGroupRefSchema,
});
const NoneResolutionSchema = Schema.TaggedStruct('NONE', {});
const BrokenResolutionSchema = Schema.TaggedStruct('BROKEN', {
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  assignmentRevision: PriceGroupRevisionSchema,
  catalogRevision: Schema.NullOr(PriceGroupRevisionSchema),
  priceGroupRef: PriceGroupRefSchema,
  reason: Schema.Literals(['MISSING', 'RETIRED', 'INCOMPATIBLE', 'UNUSABLE']),
});
const InconsistentResolutionSchema = Schema.TaggedStruct('INCONSISTENT', {
  currentAssignmentCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(2)),
});

export const CustomerPriceGroupResolutionSchema = Schema.Union([
  AssignedResolutionSchema,
  NoneResolutionSchema,
  BrokenResolutionSchema,
  InconsistentResolutionSchema,
]);
export type CustomerPriceGroupResolution = typeof CustomerPriceGroupResolutionSchema.Type;

const CustomerPriceGroupAssignmentEventFields = {
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  assignmentRevision: PriceGroupRevisionSchema,
  effectiveAt: PriceGroupInstantJsonSchema,
  priceGroupRef: PriceGroupRefSchema,
  profile: CommerceCustomerProfileTargetSchema,
} as const;

export const CustomerPriceGroupAssignedEventSchema = Schema.Struct({
  ...CustomerPriceGroupAssignmentEventFields,
  change: Schema.Literal('ASSIGNED'),
});

export const CustomerPriceGroupRemovedEventSchema = Schema.Struct({
  ...CustomerPriceGroupAssignmentEventFields,
  change: Schema.Literal('REMOVED'),
});

export const CounterpartyPriceGroupAssignedEventSchema = Schema.Struct({
  ...CustomerPriceGroupAssignedEventSchema.fields,
  counterpartyRef: CounterpartyRefSchema,
});

export const CounterpartyPriceGroupRemovedEventSchema = Schema.Struct({
  ...CustomerPriceGroupRemovedEventSchema.fields,
  counterpartyRef: CounterpartyRefSchema,
});

export const CustomerPriceGroupMigrationEventSchema = Schema.Struct({
  assignmentRefs: Schema.Array(CustomerPriceGroupAssignmentRefSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  effectiveAt: PriceGroupInstantJsonSchema,
  profiles: Schema.Array(CommerceCustomerProfileTargetSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  sourceAssignmentRefs: Schema.Array(CustomerPriceGroupAssignmentRefSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  sourcePriceGroupRef: PriceGroupRefSchema,
  targetPriceGroupRef: PriceGroupRefSchema,
});

export const CounterpartyPriceGroupMigrationEventSchema = Schema.Struct({
  ...CustomerPriceGroupMigrationEventSchema.fields,
  counterpartyRef: CounterpartyRefSchema,
});

const sameReference = (
  left: Readonly<{ moduleId: string; resourceId: string; resourceType: string; tenantId: string }>,
  right: Readonly<{ moduleId: string; resourceId: string; resourceType: string; tenantId: string }>,
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

export const samePriceGroupRef = (left: PriceGroupRef, right: PriceGroupRef): boolean => sameReference(left, right);

export const sameProfileTarget = (left: CommerceCustomerProfileTarget, right: CommerceCustomerProfileTarget): boolean =>
  left.kind === right.kind && sameReference(left, right);

export const isCustomerPriceGroupAssignmentCurrent = (
  assignment: CustomerPriceGroupAssignment,
  effectiveAt: PriceGroupInstant,
): boolean =>
  assignment.state === 'ACTIVE' &&
  assignment.effectiveFrom <= effectiveAt &&
  (assignment.effectiveTo === null || effectiveAt < assignment.effectiveTo);
