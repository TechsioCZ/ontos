import { SymmySourceOrganizationWitnessSchema } from '@app/shared-contracts/symmy/organization-source-witness';
import { Schema } from 'effect';
import {
  CounterpartyPurchasingProfileSubjectSchema,
  ProfileCreateTriggerSchema,
  ProfileInstantSchema,
} from '../domain/profile-contracts.ts';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import {
  CustomerProfileSourceAssertionSchema,
  CustomerProfilePartySourceReferenceSchema,
  CustomerProfileSourceEffectSchema,
} from '../domain/customer-profile-source.ts';

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
  partySourceReference: Schema.optionalKey(CustomerProfilePartySourceReferenceSchema),
  source: Schema.optionalKey(CustomerProfileSourceAssertionSchema),
  sourceOrganizationWitness: Schema.optionalKey(SymmySourceOrganizationWitnessSchema),
  subject: CounterpartyPurchasingProfileSubjectSchema,
  trigger: ProfileCreateTriggerSchema,
}).check(
  Schema.makeFilter((input) =>
    input.sourceOrganizationWitness !== undefined &&
    (input.source === undefined || input.source.effectId !== input.sourceOrganizationWitness.effectId)
      ? 'The source execution witness must cite this exact native source effect'
      : undefined,
  ),
  Schema.makeFilter((input) =>
    (input.source === undefined) === (input.partySourceReference === undefined)
      ? undefined
      : 'Source Profile admission requires its exact independent Party source reference',
  ),
);
export type CreateCounterpartyPurchasingProfilePayload = typeof CreateCounterpartyPurchasingProfilePayloadSchema.Type;

export const CreateCounterpartyPurchasingProfileResultSchema = Schema.Struct({
  outcome: OutcomeSchema,
  profileRef: CounterpartyPurchasingProfileRefSchema,
  revision: RevisionSchema,
  sourceEffect: Schema.optionalKey(CustomerProfileSourceEffectSchema),
  state: StateSchema,
});
export type CreateCounterpartyPurchasingProfileResult = typeof CreateCounterpartyPurchasingProfileResultSchema.Type;

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
      'SOURCE_AUTHORITY_DENIED',
      'SOURCE_CONFLICT',
      'SOURCE_STALE',
      'PRIVACY_DENIED',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
