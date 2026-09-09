import { Schema } from 'effect';
import {
  CounterpartyPurchasingProfileSubjectSchema,
  ProfileCreateTriggerSchema,
  ProfileInstantSchema,
} from '../domain/profile-contracts.ts';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';

const StateSchema = Schema.Literals(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const OutcomeSchema = Schema.Literals([
  'PROFILE_CREATED',
  'PROFILE_ALREADY_EXISTS_ACTIVE',
  'PROFILE_ALREADY_EXISTS_SUSPENDED',
  'PROFILE_ALREADY_EXISTS_ARCHIVED',
]);
const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

export const CreateCounterpartyPurchasingProfilePayloadSchema = Schema.Struct({
  effectiveAt: ProfileInstantSchema,
  subject: CounterpartyPurchasingProfileSubjectSchema,
  trigger: ProfileCreateTriggerSchema,
});
export type CreateCounterpartyPurchasingProfilePayload =
  typeof CreateCounterpartyPurchasingProfilePayloadSchema.Type;

export const CreateCounterpartyPurchasingProfileResultSchema = Schema.Struct({
  outcome: OutcomeSchema,
  profileRef: CounterpartyPurchasingProfileRefSchema,
  revision: RevisionSchema,
  state: StateSchema,
});
export type CreateCounterpartyPurchasingProfileResult =
  typeof CreateCounterpartyPurchasingProfileResultSchema.Type;

export class CreateCounterpartyPurchasingProfileRejected extends Schema.TaggedError<CreateCounterpartyPurchasingProfileRejected>()(
  'CreateCounterpartyPurchasingProfileRejected',
  {
    code: Schema.Literals([
      'SUBJECT_NOT_RESOLVED_OR_INVALID',
      'COUNTERPARTY_ROLE_NOT_ELIGIBLE',
      'PROFILE_KIND_OR_SUBJECT_CONFLICT',
      'PROFILE_RECONCILIATION_REQUIRED',
      'CURRENT_STATE_CONFLICT',
      'DEPENDENCY_UNAVAILABLE',
      'PERSISTENCE_UNAVAILABLE',
      'OUTCOME_INDETERMINATE',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
