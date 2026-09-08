// A predicate parameter that re-states the shape of a codec declared in the same file is a consumer,
// not a contract: the codec is the single thing to change. Reporting the parameter as well would
// report one defect several times in one file.
// Real occurrence: verticals/contacts/shared/apis/customer-detail.ts:61
import { Schema } from 'effect';

const ContactsDateOnlySchema = Schema.DateTimeUtc;

export const validCustomerLifecycleDates = Schema.makeFilter(
  (customer: { readonly dissolvedOn: null | string; readonly establishedOn: null | string }) =>
    customer.dissolvedOn === null || customer.establishedOn === null ? undefined : ['bad range'],
);

export const CustomerSchema = Schema.Struct({
  dissolvedOn: Schema.NullOr(ContactsDateOnlySchema),
}).check(validCustomerLifecycleDates);
