import { Schema } from 'effect';
import { ProfileInstantSchema } from '../domain/profile-contracts.ts';
import { CommerceCustomerProfileRefSchema } from '../domain/profile-decisions.ts';

const StateSchema = Schema.Literals(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

const ProfileLifecyclePayloadSchema = Schema.Struct({
  effectiveAt: ProfileInstantSchema,
  expectedRevision: RevisionSchema,
  expectedState: StateSchema,
  profileRef: CommerceCustomerProfileRefSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type ProfileLifecyclePayload = typeof ProfileLifecyclePayloadSchema.Type;

export const ProfileLifecycleResultSchema = Schema.Struct({
  effectiveAt: ProfileInstantSchema,
  outcome: Schema.Literals(['PROFILE_SUSPENDED', 'PROFILE_REACTIVATED', 'PROFILE_ARCHIVED']),
  previousState: StateSchema,
  profileRef: CommerceCustomerProfileRefSchema,
  revision: RevisionSchema,
  state: StateSchema,
});
export type ProfileLifecycleResult = typeof ProfileLifecycleResultSchema.Type;

export class ProfileLifecycleActionRejected extends Schema.TaggedError<ProfileLifecycleActionRejected>()(
  'ProfileLifecycleActionRejected',
  {
    code: Schema.Literals([
      'PROFILE_NOT_FOUND',
      'INVALID_LIFECYCLE_TRANSITION',
      'CURRENT_STATE_CONFLICT',
      'PROFILE_RECONCILIATION_REQUIRED',
      'REACTIVATION_RECONFIRMATION_REQUIRED',
      'PERSISTENCE_UNAVAILABLE',
      'OUTCOME_INDETERMINATE',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export const SuspendCustomerProfilePayloadSchema = ProfileLifecyclePayloadSchema;
export type SuspendCustomerProfilePayload = typeof SuspendCustomerProfilePayloadSchema.Type;
