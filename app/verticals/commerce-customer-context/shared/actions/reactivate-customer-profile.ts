import { Schema } from 'effect';
import { ProfileInstantSchema } from '../domain/profile-contracts.ts';
import { CommerceCustomerProfileRefSchema } from '../domain/profile-decisions.ts';

const StateSchema = Schema.Literals(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

export const ReactivateCustomerProfilePayloadSchema = Schema.Struct({
  effectiveAt: ProfileInstantSchema,
  expectedRevision: RevisionSchema,
  expectedState: StateSchema,
  profileRef: CommerceCustomerProfileRefSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type ReactivateCustomerProfilePayload = typeof ReactivateCustomerProfilePayloadSchema.Type;

export const ReactivateCustomerProfileResultSchema = Schema.Struct({
  effectiveAt: ProfileInstantSchema,
  outcome: Schema.Literals(['PROFILE_SUSPENDED', 'PROFILE_REACTIVATED', 'PROFILE_ARCHIVED']),
  previousState: StateSchema,
  profileRef: CommerceCustomerProfileRefSchema,
  revision: RevisionSchema,
  state: StateSchema,
});
export type ReactivateCustomerProfileResult = typeof ReactivateCustomerProfileResultSchema.Type;
