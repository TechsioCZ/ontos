import { Schema } from 'effect';
import {
  MembershipSourceAssertionSchema,
  MembershipSourceIdentitySchema,
  MembershipSourceManagerSchema,
  MembershipSourceRouteSchema,
} from '../domain/customer-group-membership-source.ts';
import {
  CommerceCustomerGroupMembershipSchema,
  CommerceCustomerProfileSubjectSchema,
  CustomerGroupIsoTimestampSchema,
  CustomerGroupRevisionSchema,
  CustomerGroupTextSchema,
} from '../domain/group-contract.ts';
import { CustomerGroupMembershipRefSchema } from '../resources/customer-group-membership.ts';
import { CustomerGroupRefSchema } from '../resources/customer-group.ts';
import {
  OrganizationCompleteMembershipSnapshotSchema,
  OrganizationMembershipSourcePayloadSchema,
  OrganizationMembershipSourceResultSchema,
} from '../domain/organization-membership-source.ts';

const baseFields = {
  effectiveAt: CustomerGroupIsoTimestampSchema,
  manager: MembershipSourceManagerSchema,
  processingKind: Schema.optionalKey(Schema.Never),
  profile: CommerceCustomerProfileSubjectSchema,
  reason: CustomerGroupTextSchema,
  reasonCode: Schema.optionalKey(Schema.Never),
  route: MembershipSourceRouteSchema,
  source: MembershipSourceAssertionSchema,
};

const distinctGroupRefs = Schema.makeFilter(
  (payload: { readonly groupRefs: readonly (typeof CustomerGroupRefSchema.Type)[] }) =>
    new Set(payload.groupRefs.map((group) => group.resourceId)).size === payload.groupRefs.length
      ? undefined
      : [{ issue: 'A source Membership set must name each group at most once', path: ['groupRefs'] }],
);

const PersonCompleteCustomerGroupMembershipSnapshotSchema = Schema.Struct({
  ...baseFields,
  completenessProofRef: MembershipSourceIdentitySchema,
  groupRefs: Schema.Array(CustomerGroupRefSchema).check(Schema.isMaxLength(100)),
  operation: Schema.Literal('COMPLETE'),
}).check(distinctGroupRefs);
export const CompleteCustomerGroupMembershipSnapshotSchema = Schema.Union([
  PersonCompleteCustomerGroupMembershipSnapshotSchema,
  OrganizationCompleteMembershipSnapshotSchema,
]);
export type CompleteCustomerGroupMembershipSnapshot = typeof CompleteCustomerGroupMembershipSnapshotSchema.Type;

export const ApplyCustomerGroupMembershipSourcePayloadSchema = Schema.Union([
  Schema.Struct({
    ...baseFields,
    groupRef: CustomerGroupRefSchema,
    operation: Schema.Literal('ASSIGN'),
  }),
  Schema.Struct({
    ...baseFields,
    expectedRevision: CustomerGroupRevisionSchema,
    groupRef: CustomerGroupRefSchema,
    membershipRef: CustomerGroupMembershipRefSchema,
    operation: Schema.Literal('REMOVE'),
  }),
  PersonCompleteCustomerGroupMembershipSnapshotSchema,
  Schema.Struct({
    ...baseFields,
    groupRefs: Schema.Array(CustomerGroupRefSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    operation: Schema.Literal('PARTIAL'),
  }).check(distinctGroupRefs),
  ...OrganizationMembershipSourcePayloadSchema.members,
]);

export type ApplyCustomerGroupMembershipSourcePayload = typeof ApplyCustomerGroupMembershipSourcePayloadSchema.Type;

const PersonCustomerGroupMembershipSourceResultSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Union([
      Schema.Struct({
        membership: CommerceCustomerGroupMembershipSchema,
        outcome: Schema.Literals(['ASSIGNED', 'ENDED']),
      }),
      Schema.Struct({
        groupRef: CustomerGroupRefSchema,
        outcome: Schema.Literals(['ALREADY_MANAGED', 'SATISFIED_BY_OTHER_MANAGER']),
      }),
    ]),
  ),
  processingKind: Schema.optionalKey(Schema.Never),
  reasonCode: Schema.optionalKey(Schema.Never),
  source: MembershipSourceAssertionSchema,
});
export const ApplyCustomerGroupMembershipSourceResultSchema = Schema.Union([
  OrganizationMembershipSourceResultSchema,
  PersonCustomerGroupMembershipSourceResultSchema,
]);

export type ApplyCustomerGroupMembershipSourceResult = typeof ApplyCustomerGroupMembershipSourceResultSchema.Type;

const membershipSourceRejectionFields = {
  code: Schema.Literals([
    'SOURCE_AUTHORITY_DENIED',
    'SOURCE_CONFLICT',
    'SOURCE_SCOPE_MISMATCH',
    'SOURCE_STALE',
    'TARGET_INELIGIBLE',
    'TARGET_NOT_FOUND',
    'PERSISTENCE_UNAVAILABLE',
  ]),
  reason: CustomerGroupTextSchema,
};

export class CustomerGroupMembershipSourceRejected extends Schema.TaggedError<CustomerGroupMembershipSourceRejected>()(
  'CustomerGroupMembershipSourceRejected',
  membershipSourceRejectionFields,
) {}
