// expect-count: 5
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

const ContactsIsoTimestampSchema = Schema.String.check(Schema.isMinLength(1));
const ContactsIcoSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/u));

export const CustomerDetailSchema = Schema.Struct({
  archivedAt: Schema.NullOr(ContactsIsoTimestampSchema),
  ico: Schema.NullOr(ContactsIcoSchema),
  legalName: Schema.String,
});

export class CustomerNotFound extends Schema.TaggedError<CustomerNotFound>()('CustomerNotFound', {
  archivedAt: Schema.NullOr(ContactsIsoTimestampSchema),
}) {}

export const CustomerListSchema = Schema.Struct({
  items: Schema.Array(CustomerDetailSchema),
  nextOffset: Schema.NullOr(Schema.Finite.check(Schema.isInt())),
});

export const group = HttpApiGroup.make('customers').add(
  HttpApiEndpoint.get('detail')`/customers`.addSuccess(
    Schema.Struct({ deletedAt: Schema.NullishOr(Schema.String) }),
  ),
);
