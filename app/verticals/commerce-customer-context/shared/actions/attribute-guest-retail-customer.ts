import { PartyRefSchema } from '@app/party-registry/resources/party';
import { Schema } from 'effect';
import {
  ProfileBoundedKeySchema,
  ProfileInstantSchema,
  SellingLegalEntityRefSchema,
} from '../domain/profile-contracts.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';

export const AttributeGuestRetailCustomerPayloadSchema = Schema.Struct({
  correlationRoot: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  guestEvidenceRef: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  requestedAt: ProfileInstantSchema,
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
});
export type AttributeGuestRetailCustomerPayload =
  typeof AttributeGuestRetailCustomerPayloadSchema.Type;

export const AttributeGuestRetailCustomerResultSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal('ATTRIBUTED'),
    partyRef: PartyRefSchema,
    profileRef: RetailCustomerProfileRefSchema,
  }),
  Schema.Struct({ outcome: Schema.Literal('PARTY_UNRESOLVED') }),
  Schema.Struct({
    outcome: Schema.Literal('PARTY_AMBIGUOUS'),
    reconciliationRef: ProfileBoundedKeySchema,
  }),
  Schema.Struct({ outcome: Schema.Literal('PARTY_INVALID') }),
  Schema.Struct({ outcome: Schema.Literal('PROFILE_NOT_ACTIVE') }),
]);
export type AttributeGuestRetailCustomerResult =
  typeof AttributeGuestRetailCustomerResultSchema.Type;

export class AttributeGuestRetailCustomerRejected extends Schema.TaggedError<AttributeGuestRetailCustomerRejected>()(
  'AttributeGuestRetailCustomerRejected',
  {
    code: Schema.Literals([
      'PARTY_REGISTRY_UNAVAILABLE',
      'PROFILE_RECONCILIATION_REQUIRED',
      'CURRENT_STATE_CONFLICT',
      'PERSISTENCE_UNAVAILABLE',
      'OUTCOME_INDETERMINATE',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
