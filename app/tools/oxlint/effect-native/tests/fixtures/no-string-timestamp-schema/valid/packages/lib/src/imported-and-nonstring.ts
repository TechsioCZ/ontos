import { Schema } from 'effect';

import { ContactsIsoTimestampSchema } from './external-contract.ts';

// The imported codec is reported in the module that declares it, never at the use site.
export const CustomerSchema = Schema.Struct({
  createdAt: ContactsIsoTimestampSchema,
  archivedAt: Schema.NullOr(ContactsIsoTimestampSchema),
  // Non-string temporal values are outside this rule.
  epochAt: Schema.Number,
  windowAt: Schema.Struct({ from: Schema.DateTimeUtc, to: Schema.DateTimeUtc }),
});

// Not a Schema field bag: an ordinary options object.
export const defaults = {
  createdAt: 'unset',
  refreshedAt: '',
};
