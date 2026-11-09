import { Schema } from 'effect';
import {
  ProfileCreateTriggerSchema,
  ProfileInstantSchema,
  RetailCustomerProfileSubjectSchema,
} from '../domain/profile-contracts.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import {
  CustomerProfileSourceAssertionSchema,
  CustomerProfilePartySourceReferenceSchema,
  CustomerProfileSourceEffectSchema,
} from '../domain/customer-profile-source.ts';

const ProfileStateSchema = Schema.Literals(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const CreateOutcomeSchema = Schema.Literals([
  'PROFILE_CREATED',
  'PROFILE_ALREADY_EXISTS_ACTIVE',
  'PROFILE_ALREADY_EXISTS_SUSPENDED',
  'PROFILE_ALREADY_EXISTS_ARCHIVED',
]);
const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

export const EnsureRetailCustomerProfilePayloadSchema = Schema.Struct({
  effectiveAt: ProfileInstantSchema,
  partySourceReference: Schema.optionalKey(CustomerProfilePartySourceReferenceSchema),
  source: Schema.optionalKey(CustomerProfileSourceAssertionSchema),
  subject: RetailCustomerProfileSubjectSchema,
  trigger: ProfileCreateTriggerSchema,
}).check(
  Schema.makeFilter((input) =>
    (input.source === undefined) === (input.partySourceReference === undefined)
      ? undefined
      : 'Source Profile admission requires its exact independent Party source reference',
  ),
);
export type EnsureRetailCustomerProfilePayload = typeof EnsureRetailCustomerProfilePayloadSchema.Type;

export const EnsureRetailCustomerProfileResultSchema = Schema.Struct({
  outcome: CreateOutcomeSchema,
  profileRef: RetailCustomerProfileRefSchema,
  revision: RevisionSchema,
  sourceEffect: Schema.optionalKey(CustomerProfileSourceEffectSchema),
  state: ProfileStateSchema,
});
export type EnsureRetailCustomerProfileResult = typeof EnsureRetailCustomerProfileResultSchema.Type;

export class EnsureRetailCustomerProfileRejected extends Schema.TaggedError<EnsureRetailCustomerProfileRejected>()(
  'EnsureRetailCustomerProfileRejected',
  {
    code: Schema.Literals([
      'SUBJECT_NOT_RESOLVED_OR_INVALID',
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
