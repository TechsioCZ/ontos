import { Schema } from 'effect';
import { CompleteCustomerGroupMembershipSnapshotSchema } from '../actions/apply-customer-group-membership-source.ts';
import { MembershipSourceIdentitySchema } from './customer-group-membership-source.ts';
import { CustomerGroupIsoTimestampSchema } from './group-contract.ts';

/** Explicit source contract qualification is configuration-owned, never inferred from an empty list. */
export const MembershipSnapshotCompletenessContractSchema = Schema.Struct({
  coverage: Schema.Literal('ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE'),
  ref: MembershipSourceIdentitySchema,
  revision: MembershipSourceIdentitySchema,
});

export const AdmitCustomerGroupMembershipSnapshotPayloadSchema = Schema.Struct({
  completenessContract: MembershipSnapshotCompletenessContractSchema,
  expiresAt: CustomerGroupIsoTimestampSchema,
  snapshot: CompleteCustomerGroupMembershipSnapshotSchema,
});
export type AdmitCustomerGroupMembershipSnapshotPayload = typeof AdmitCustomerGroupMembershipSnapshotPayloadSchema.Type;

export const AdmitCustomerGroupMembershipSnapshotResultSchema = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  expiresAt: CustomerGroupIsoTimestampSchema,
  proofRef: MembershipSourceIdentitySchema,
});
export type AdmitCustomerGroupMembershipSnapshotResult = typeof AdmitCustomerGroupMembershipSnapshotResultSchema.Type;
