import { SourceProcessingEligibilityRequestSchema } from '@app/privacy/api/source-processing-eligibility';
import { Schema } from 'effect';
import { AddressBookDomainErrorSchema } from './address-errors.ts';
import { AddressBookProfileSchema, SavedAddressPurposesSchema, SavedAddressPurposeSchema } from './address-book.ts';
import { SavedAddressRefSchema } from '../resources/saved-address.ts';

const KeySchema = Schema.toEncoded(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isPattern(/^\S(?:[\s\S]*\S)?$/u)).pipe(
    Schema.brand('SavedAddressSourceKey'),
  ),
);
export const SavedAddressSourceAssertionSchema = Schema.Struct({
  effectId: KeySchema,
  identity: SourceProcessingEligibilityRequestSchema.fields.source,
  mappingRevision: KeySchema,
  nativeAddressId: Schema.optionalKey(SavedAddressRefSchema.fields.resourceId),
  order: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 0 })),
  purposes: SavedAddressPurposesSchema,
  revision: KeySchema,
  routeRevision: KeySchema,
}).check(
  Schema.makeFilter((source) =>
    source.identity === null ||
    Object.values(source.identity).some((value) => value.length === 0 || value.length > 300 || value.trim() !== value)
      ? 'An external Saved Address requires an actual bounded qualified source identity'
      : undefined,
  ),
);
export type SavedAddressSourceAssertion = typeof SavedAddressSourceAssertionSchema.Type;
export const SavedAddressSourceActionKeySchema = Schema.Literals([
  'commerce.customer-context.add-saved-address',
  'commerce.customer-context.update-saved-address',
  'commerce.customer-context.remove-saved-address',
]);
export const SavedAddressSourceOperationSchema = Schema.Literals(['ADD', 'UPDATE', 'REMOVE']);
export const SavedAddressSourceRequestHashSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const SavedAddressSourceInvocationIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SavedAddressSourceInvocationId')),
);
export const SavedAddressSourceReceiptSchema = Schema.Struct({
  actionInvocationId: SavedAddressSourceInvocationIdSchema,
  clearedDefaults: Schema.Array(SavedAddressPurposeSchema),
  operation: SavedAddressSourceOperationSchema,
  outcome: Schema.Literals(['ADDED', 'REUSED', 'UPDATED', 'UNCHANGED', 'REMOVED', 'ALREADY_REMOVED']),
  profile: AddressBookProfileSchema,
  requestHash: SavedAddressSourceRequestHashSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  savedAddressRef: SavedAddressRefSchema,
}).check(
  Schema.makeFilter((receipt) => {
    const outcomes = {
      ADD: new Set(['ADDED', 'REUSED']),
      REMOVE: new Set(['REMOVED', 'ALREADY_REMOVED']),
      UPDATE: new Set(['UPDATED', 'UNCHANGED']),
    };
    return receipt.savedAddressRef.tenantId === receipt.profile.profileRef.tenantId &&
      outcomes[receipt.operation].has(receipt.outcome)
      ? undefined
      : 'The receipt must retain the exact native operation outcome and Tenant';
  }),
);
export class SavedAddressSourceRejected extends Schema.TaggedError<SavedAddressSourceRejected>()(
  'SavedAddressSourceRejected',
  {
    code: Schema.Literals([
      'saved_address_source_authority_denied',
      'saved_address_source_conflict',
      'saved_address_source_stale',
      'saved_address_source_recovery_required',
      'saved_address_source_target_already_bound',
      'saved_address_source_privacy_denied',
    ]),
    reason: Schema.String,
  },
) {}

export const SourceSavedAddressDomainErrorSchema = Schema.Union([
  ...AddressBookDomainErrorSchema.members,
  SavedAddressSourceRejected,
]);
