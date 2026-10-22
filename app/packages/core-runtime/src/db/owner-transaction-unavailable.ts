import { Schema } from 'effect';

/** A short owner transaction could not be opened, admitted, or committed. */
export class OwnerTransactionUnavailable extends Schema.TaggedError<OwnerTransactionUnavailable>()(
  'OwnerTransactionUnavailable',
  {
    code: Schema.Literal('owner_transaction_unavailable'),
    reason: Schema.String,
  },
) {}
