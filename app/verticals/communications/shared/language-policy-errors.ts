import { Schema } from 'effect';

/**
 * The Tenant's language mode cannot be read or written. A reader treats this as "unreadable" and fails closed: the new
 * handoff is not allowed, and nothing falls back to the platform default, because a proven absence of an own choice is
 * not the same fact as an unreadable setting.
 */
const unavailableFields = {
  cause: Schema.optionalKey(Schema.Unknown),
  code: Schema.Literal('language_policy_store_unavailable'),
  reason: Schema.String,
};
const unavailableContract = Schema.TaggedStruct('LanguagePolicyStoreUnavailable', unavailableFields);
export const LanguagePolicyStoreUnavailable = Schema.TaggedError<typeof unavailableContract.Type>()(
  'LanguagePolicyStoreUnavailable',
  unavailableFields,
);
