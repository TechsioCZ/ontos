import { Schema } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { CustomerGroupMembershipRefSchema } from '../resources/customer-group-membership.ts';
import { CustomerGroupRefSchema } from '../resources/customer-group.ts';
import {
  MembershipSourceAssertionSchema,
  MembershipSourceEffectIdSchema,
  MembershipSourceIdentitySchema,
  MembershipSourceManagerSchema,
  MembershipSourceRouteSchema,
} from './customer-group-membership-source.ts';
import { CustomerGroupIsoTimestampSchema, CustomerGroupRevisionSchema } from './group-contract.ts';

export const ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION = 'commerce.customer-context.organization-membership-fields.v1';

const receiptFields = [
  'processingKind',
  'reasonCode',
  'source.assertionId',
  'source.effectId',
  'source.order',
  'source.sourceRecordId',
  'items[].outcome',
  'items[].groupRef.moduleId',
  'items[].groupRef.resourceId',
  'items[].groupRef.resourceType',
  'items[].groupRef.tenantId',
  'items[].membership.assignedAt',
  'items[].membership.effectiveFrom',
  'items[].membership.effectiveTo',
  'items[].membership.groupRef.moduleId',
  'items[].membership.groupRef.resourceId',
  'items[].membership.groupRef.resourceType',
  'items[].membership.groupRef.tenantId',
  'items[].membership.membershipRef.moduleId',
  'items[].membership.membershipRef.resourceId',
  'items[].membership.membershipRef.resourceType',
  'items[].membership.membershipRef.tenantId',
  'items[].membership.profile.profileKind',
  'items[].membership.profile.profileRef.moduleId',
  'items[].membership.profile.profileRef.resourceId',
  'items[].membership.profile.profileRef.resourceType',
  'items[].membership.profile.profileRef.tenantId',
  'items[].membership.revision',
  'items[].membership.state',
  'items[].membership.removal.effectiveAt',
  'items[].membership.removal.kind',
  'items[].membership.removal.recordedAt',
] as const;
const queryFields = [
  'manager.factFamily',
  'manager.issuer',
  'manager.sourceNamespace',
  'manager.tenantId',
  'profile.profileKind',
  'profile.profileRef.moduleId',
  'profile.profileRef.resourceId',
  'profile.profileRef.resourceType',
  'profile.profileRef.tenantId',
  'route.id',
  'route.revision',
] as const;

/** Exact finite policy fields. Source/control identifiers require explicit governed metadata scope. */
export const ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS = [...receiptFields, ...queryFields, 'effectId'] as const;
export const ORGANIZATION_MEMBERSHIP_WRITE_FIELDS = [
  ...receiptFields,
  ...queryFields,
  'operation',
  'effectiveAt',
  'expectedRevision',
  'completenessProofRef',
  'groupRef.moduleId',
  'groupRef.resourceId',
  'groupRef.resourceType',
  'groupRef.tenantId',
  'groupRefs[].moduleId',
  'groupRefs[].resourceId',
  'groupRefs[].resourceType',
  'groupRefs[].tenantId',
  'membershipRef.moduleId',
  'membershipRef.resourceId',
  'membershipRef.resourceType',
  'membershipRef.tenantId',
  'completenessContract.ref',
  'completenessContract.revision',
  'completenessContract.coverage',
  'digest',
  'expiresAt',
  'proofRef',
  'snapshot.processingKind',
  'snapshot.reasonCode',
  'snapshot.operation',
  'snapshot.effectiveAt',
  'snapshot.completenessProofRef',
  'snapshot.manager.factFamily',
  'snapshot.manager.issuer',
  'snapshot.manager.sourceNamespace',
  'snapshot.manager.tenantId',
  'snapshot.profile.profileKind',
  'snapshot.profile.profileRef.moduleId',
  'snapshot.profile.profileRef.resourceId',
  'snapshot.profile.profileRef.resourceType',
  'snapshot.profile.profileRef.tenantId',
  'snapshot.route.id',
  'snapshot.route.revision',
  'snapshot.source.assertionId',
  'snapshot.source.effectId',
  'snapshot.source.order',
  'snapshot.source.sourceRecordId',
  'snapshot.groupRefs[].moduleId',
  'snapshot.groupRefs[].resourceId',
  'snapshot.groupRefs[].resourceType',
  'snapshot.groupRefs[].tenantId',
] as const;

export const OrganizationMembershipProcessingKindSchema = Schema.Literal('ORG_BUSINESS_REFERENCE');
export const OrganizationMembershipReasonCodeSchema = Schema.Literals([
  'SOURCE_MEMBERSHIP_ASSERTED',
  'SOURCE_MEMBERSHIP_WITHDRAWN',
  'SOURCE_COMPLETE_SET_RECONCILED',
  'SOURCE_PARTIAL_SET_ASSERTED',
]);
export const OrganizationMembershipProfileSchema = Schema.Struct({
  profileKind: Schema.Literal('COUNTERPARTY'),
  profileRef: CounterpartyPurchasingProfileRefSchema,
});

const fields = {
  effectiveAt: CustomerGroupIsoTimestampSchema,
  manager: MembershipSourceManagerSchema,
  processingKind: OrganizationMembershipProcessingKindSchema,
  profile: OrganizationMembershipProfileSchema,
  reason: Schema.optionalKey(Schema.Never),
  route: MembershipSourceRouteSchema,
  source: MembershipSourceAssertionSchema,
};
const distinctGroups = Schema.makeFilter(
  (input: { readonly groupRefs: readonly (typeof CustomerGroupRefSchema.Type)[] }) =>
    new Set(input.groupRefs.map((ref) => ref.resourceId)).size === input.groupRefs.length
      ? undefined
      : [{ issue: 'A source Membership set must name each group at most once', path: ['groupRefs'] }],
);
export const OrganizationCompleteMembershipSnapshotSchema = Schema.Struct({
  ...fields,
  completenessProofRef: MembershipSourceIdentitySchema,
  groupRefs: Schema.Array(CustomerGroupRefSchema).check(Schema.isMaxLength(100)),
  operation: Schema.Literal('COMPLETE'),
  reasonCode: Schema.Literal('SOURCE_COMPLETE_SET_RECONCILED'),
}).check(distinctGroups);
export const OrganizationMembershipSourcePayloadSchema = Schema.Union([
  Schema.Struct({
    ...fields,
    groupRef: CustomerGroupRefSchema,
    operation: Schema.Literal('ASSIGN'),
    reasonCode: Schema.Literal('SOURCE_MEMBERSHIP_ASSERTED'),
  }),
  Schema.Struct({
    ...fields,
    expectedRevision: CustomerGroupRevisionSchema,
    groupRef: CustomerGroupRefSchema,
    membershipRef: CustomerGroupMembershipRefSchema,
    operation: Schema.Literal('REMOVE'),
    reasonCode: Schema.Literal('SOURCE_MEMBERSHIP_WITHDRAWN'),
  }),
  OrganizationCompleteMembershipSnapshotSchema,
  Schema.Struct({
    ...fields,
    groupRefs: Schema.Array(CustomerGroupRefSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    operation: Schema.Literal('PARTIAL'),
    reasonCode: Schema.Literal('SOURCE_PARTIAL_SET_ASSERTED'),
  }).check(distinctGroups),
]);
export type OrganizationMembershipSourcePayload = typeof OrganizationMembershipSourcePayloadSchema.Type;

/** Native membership identity and period only. Free-text reasons never enter this projection. */
export const OrganizationGroupMembershipSchema = Schema.Struct({
  assignedAt: CustomerGroupIsoTimestampSchema,
  assignmentReason: Schema.optionalKey(Schema.Never),
  effectiveFrom: CustomerGroupIsoTimestampSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(CustomerGroupIsoTimestampSchema)),
  groupRef: CustomerGroupRefSchema,
  membershipRef: CustomerGroupMembershipRefSchema,
  profile: OrganizationMembershipProfileSchema,
  removal: Schema.toEncoded(
    Schema.OptionFromNullOr(
      Schema.Struct({
        effectiveAt: CustomerGroupIsoTimestampSchema,
        kind: Schema.Literals(['EXPLICIT_END', 'EXPLICIT_CANCEL', 'GROUP_ARCHIVED']),
        reason: Schema.optionalKey(Schema.Never),
        recordedAt: CustomerGroupIsoTimestampSchema,
      }),
    ),
  ),
  revision: CustomerGroupRevisionSchema,
  state: Schema.Literals(['VALID', 'CANCELLED']),
}).check(
  Schema.makeFilter((membership) =>
    membership.effectiveTo === null || membership.effectiveTo > membership.effectiveFrom
      ? undefined
      : [{ issue: 'effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
  ),
);
export const OrganizationMembershipSourceResultSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Union([
      Schema.Struct({
        membership: OrganizationGroupMembershipSchema,
        outcome: Schema.Literals(['ASSIGNED', 'ENDED']),
      }),
      Schema.Struct({
        groupRef: CustomerGroupRefSchema,
        outcome: Schema.Literals(['ALREADY_MANAGED', 'SATISFIED_BY_OTHER_MANAGER']),
      }),
    ]),
  ),
  processingKind: OrganizationMembershipProcessingKindSchema,
  reasonCode: OrganizationMembershipReasonCodeSchema,
  source: MembershipSourceAssertionSchema,
});
export type OrganizationMembershipSourceResult = typeof OrganizationMembershipSourceResultSchema.Type;

export const OrganizationMembershipSourceReceiptRequestSchema = Schema.Struct({
  effectId: MembershipSourceEffectIdSchema,
  manager: MembershipSourceManagerSchema,
  processingKind: OrganizationMembershipProcessingKindSchema,
  profile: OrganizationMembershipProfileSchema,
  route: MembershipSourceRouteSchema,
});

export const OrganizationMembershipChangeEventSchema = Schema.Struct({
  membership: OrganizationGroupMembershipSchema,
  processingKind: OrganizationMembershipProcessingKindSchema,
  reasonCode: OrganizationMembershipReasonCodeSchema,
  source: MembershipSourceAssertionSchema,
});
