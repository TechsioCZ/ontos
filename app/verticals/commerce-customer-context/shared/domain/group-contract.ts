import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { CustomerGroupMembershipRefSchema } from '../resources/customer-group-membership.ts';
import { CustomerGroupRefSchema } from '../resources/customer-group.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import {
  CustomerGroupMembershipManagementSchema,
  MembershipSourceAssertionSchema,
  MembershipSourceManagerSchema,
  MembershipSourceOrderSchema,
} from './customer-group-membership-source.ts';

export const CustomerGroupRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
export const CustomerGroupLegalEntityIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CustomerGroupLegalEntityId')),
);
export const CustomerGroupTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const CustomerGroupDefinitionTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
export const CustomerGroupBusinessCodeSchema = Schema.Trim.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
);
export const CustomerGroupMeaningKeySchema = Schema.Trim.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('CustomerGroupMeaningKey'));
export type CustomerGroupMeaningKey = typeof CustomerGroupMeaningKeySchema.Type;

const DefinitionSourceKeySchema = Schema.toEncoded(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isPattern(/^\S(?:[\s\S]*\S)?$/u)).pipe(
    Schema.brand('CustomerGroupDefinitionSourceKey'),
  ),
);
/** Declared source evidence, never authority by itself; the owner checks the current route binding. */
export const CustomerGroupDefinitionSourceSchema = Schema.Struct({
  definitionEvidence: Schema.Struct({
    kind: Schema.Literals(['SOURCE_RECORD', 'NAMED_CONFIGURATION']),
    reference: DefinitionSourceKeySchema,
    revision: DefinitionSourceKeySchema,
  }),
  effectId: DefinitionSourceKeySchema,
  issuer: DefinitionSourceKeySchema,
  mappingRevision: DefinitionSourceKeySchema,
  namespace: DefinitionSourceKeySchema,
  order: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 0 })),
  recordId: DefinitionSourceKeySchema,
  revision: DefinitionSourceKeySchema,
  route: Schema.Struct({ id: DefinitionSourceKeySchema, revision: DefinitionSourceKeySchema }),
  sourceCode: DefinitionSourceKeySchema,
});
export type CustomerGroupDefinitionSource = typeof CustomerGroupDefinitionSourceSchema.Type;

export class CustomerGroupDefinitionSourceRejected extends Schema.TaggedError<CustomerGroupDefinitionSourceRejected>()(
  'CustomerGroupDefinitionSourceRejected',
  {
    code: Schema.Literals([
      'customer_group_source_authority_denied',
      'customer_group_source_conflict',
      'customer_group_source_stale',
    ]),
    reason: Schema.String,
  },
) {}

const customerGroupCanonicalInstant = Schema.makeFilter((value: string) => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
    ? undefined
    : 'timestamp must be one canonical UTC instant with millisecond precision';
});
const CustomerGroupInstantSchema = Schema.String.check(customerGroupCanonicalInstant).pipe(
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);

/** JSON-compatible canonical UTC instant used by public Action and Read contracts. */
export const CustomerGroupIsoTimestampSchema = Schema.toEncoded(CustomerGroupInstantSchema);
export type CustomerGroupIsoTimestamp = typeof CustomerGroupIsoTimestampSchema.Type;

export const CommerceCustomerProfileSubjectSchema = Schema.Union([
  Schema.Struct({
    profileKind: Schema.Literal('RETAIL'),
    profileRef: RetailCustomerProfileRefSchema,
  }),
  Schema.Struct({
    profileKind: Schema.Literal('COUNTERPARTY'),
    profileRef: CounterpartyPurchasingProfileRefSchema,
  }),
]);
export type CommerceCustomerProfileSubject = typeof CommerceCustomerProfileSubjectSchema.Type;

const CustomerGroupDefinitionChangeKindSchema = Schema.Literals([
  'CREATED',
  'COSMETIC_RENAME',
  'DESCRIPTION_CLARIFICATION',
]);

export const CustomerGroupDefinitionRevisionSchema = Schema.Struct({
  changeKind: CustomerGroupDefinitionChangeKindSchema,
  description: CustomerGroupDefinitionTextSchema,
  membershipCriteria: CustomerGroupDefinitionTextSchema,
  name: CustomerGroupTextSchema,
  purpose: CustomerGroupDefinitionTextSchema,
  reason: CustomerGroupTextSchema,
  recordedAt: CustomerGroupIsoTimestampSchema,
  revision: CustomerGroupRevisionSchema,
});
export type CustomerGroupDefinitionRevision = typeof CustomerGroupDefinitionRevisionSchema.Type;

const CustomerGroupLifecyclePeriodSchema = Schema.Struct({
  activeFrom: CustomerGroupIsoTimestampSchema,
  archivedAt: Schema.toEncoded(Schema.OptionFromNullOr(CustomerGroupInstantSchema)),
  reason: CustomerGroupTextSchema,
  recordedAt: CustomerGroupIsoTimestampSchema,
});

export const CommerceCustomerGroupSchema = Schema.Struct({
  businessCode: CustomerGroupBusinessCodeSchema,
  currentDefinition: CustomerGroupDefinitionRevisionSchema,
  currentState: Schema.Literals(['ACTIVE', 'ARCHIVED']),
  definitionHistory: Schema.Array(CustomerGroupDefinitionRevisionSchema),
  groupRef: CustomerGroupRefSchema,
  lifecycleHistory: Schema.Array(CustomerGroupLifecyclePeriodSchema),
  meaningKey: CustomerGroupMeaningKeySchema,
  revision: CustomerGroupRevisionSchema,
});
export type CommerceCustomerGroup = typeof CommerceCustomerGroupSchema.Type;

const CustomerGroupMembershipRemovalSchema = Schema.Struct({
  effectiveAt: CustomerGroupIsoTimestampSchema,
  kind: Schema.Literals(['EXPLICIT_END', 'EXPLICIT_CANCEL', 'GROUP_ARCHIVED']),
  reason: CustomerGroupTextSchema,
  recordedAt: CustomerGroupIsoTimestampSchema,
  source: Schema.optionalKey(MembershipSourceAssertionSchema),
});

const checkMembershipInterval = Schema.makeFilter(
  (membership: Readonly<{ effectiveFrom: string; effectiveTo: string | null }>) =>
    membership.effectiveTo === null || membership.effectiveTo > membership.effectiveFrom
      ? undefined
      : [{ issue: 'effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
);

export const CommerceCustomerGroupMembershipSchema = Schema.Struct({
  assignedAt: CustomerGroupIsoTimestampSchema,
  assignmentReason: CustomerGroupTextSchema,
  effectiveFrom: CustomerGroupIsoTimestampSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(CustomerGroupInstantSchema)),
  groupRef: CustomerGroupRefSchema,
  management: Schema.optionalKey(CustomerGroupMembershipManagementSchema),
  membershipRef: CustomerGroupMembershipRefSchema,
  profile: CommerceCustomerProfileSubjectSchema,
  removal: Schema.toEncoded(Schema.OptionFromNullOr(CustomerGroupMembershipRemovalSchema)),
  revision: CustomerGroupRevisionSchema,
  state: Schema.Literals(['VALID', 'CANCELLED']),
}).check(checkMembershipInterval);
export type CommerceCustomerGroupMembership = typeof CommerceCustomerGroupMembershipSchema.Type;

const MembershipSourceReadSchema = Schema.Struct({ order: MembershipSourceOrderSchema });
const MembershipRemovalReadSchema = Schema.Struct({
  ...CustomerGroupMembershipRemovalSchema.fields,
  source: Schema.optionalKey(MembershipSourceReadSchema),
});
const MembershipManagementReadSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('MANUAL') }),
  Schema.Struct({ kind: Schema.Literal('LEGACY_UNATTRIBUTED') }),
  Schema.Struct({
    kind: Schema.Literal('EXTERNAL_SOURCE'),
    manager: MembershipSourceManagerSchema,
    source: MembershipSourceReadSchema,
  }),
]);

/** Ordinary Membership Reads expose attribution and source order without recovery identifiers. */
export const CommerceCustomerGroupMembershipReadSchema = Schema.Struct({
  ...CommerceCustomerGroupMembershipSchema.fields,
  management: Schema.optionalKey(MembershipManagementReadSchema),
  removal: Schema.toEncoded(Schema.OptionFromNullOr(MembershipRemovalReadSchema)),
}).check(checkMembershipInterval);
export type CommerceCustomerGroupMembershipRead = typeof CommerceCustomerGroupMembershipReadSchema.Type;

export const CustomerGroupProfileLifecycleSchema = Schema.Literals([
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED',
  'RECONCILIATION_REQUIRED',
]);
export type CustomerGroupProfileLifecycle = typeof CustomerGroupProfileLifecycleSchema.Type;

export const CustomerGroupPageLimitSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 100, minimum: 1 }),
);

export const CustomerGroupActionAuditEvidenceSchema = Schema.Struct({
  affectedMembershipCount: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  afterDefinitionRevision: Schema.optionalKey(CustomerGroupRevisionSchema),
  beforeDefinitionRevision: Schema.optionalKey(CustomerGroupRevisionSchema),
  changed: Schema.Boolean,
  definitionChangeKind: Schema.optionalKey(CustomerGroupDefinitionChangeKindSchema),
  effectiveAt: CustomerGroupIsoTimestampSchema,
  groupRef: CustomerGroupRefSchema,
  membership: Schema.optionalKey(CommerceCustomerGroupMembershipSchema),
  operation: Schema.Literals(['CREATE', 'UPDATE', 'ARCHIVE', 'REACTIVATE', 'ASSIGN', 'REMOVE']),
  reason: CustomerGroupTextSchema,
  revision: CustomerGroupRevisionSchema,
});

// oxlint-disable-next-line eslint/no-unused-vars -- Reserved private schema retained as part of the customer-group contract structure.
const CustomerGroupPageSchema = Schema.Struct({
  items: Schema.Array(CommerceCustomerGroupMembershipSchema),
  nextCursor: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
});
