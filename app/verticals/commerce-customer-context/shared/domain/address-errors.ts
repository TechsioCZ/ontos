import { Schema } from 'effect';

export class AddressBookUnavailable extends Schema.TaggedError<AddressBookUnavailable>()(
  'AddressBookUnavailable',
  {
    code: Schema.Literal('address_book_unavailable'),
    dependency: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export const SavedAddressInvalidSchema = Schema.TaggedStruct('SavedAddressInvalid', {
  code: Schema.Literal('saved_address_invalid'),
  reason: Schema.String,
});
export const SavedAddressNotFoundSchema = Schema.TaggedStruct('SavedAddressNotFound', {
  code: Schema.Literal('saved_address_not_found'),
  reason: Schema.String,
});
export const SavedAddressConflictSchema = Schema.TaggedStruct('SavedAddressConflict', {
  code: Schema.Literal('saved_address_conflict'),
  reason: Schema.String,
});
export const SavedAddressReconciliationRequiredSchema = Schema.TaggedStruct(
  'SavedAddressReconciliationRequired',
  {
    code: Schema.Literal('saved_address_reconciliation_required'),
    reason: Schema.String,
  },
);
export const SavedAddressSourceTransitionRequiredSchema = Schema.TaggedStruct(
  'SavedAddressSourceTransitionRequired',
  {
    code: Schema.Literal('saved_address_source_transition_required'),
    reason: Schema.String,
  },
);

export const AddressBookDomainErrorSchema = Schema.Union([
  AddressBookUnavailable,
  SavedAddressConflictSchema,
  SavedAddressInvalidSchema,
  SavedAddressNotFoundSchema,
  SavedAddressReconciliationRequiredSchema,
  SavedAddressSourceTransitionRequiredSchema,
]);
