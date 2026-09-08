import { Option, Schema } from 'effect';

const CustomerSchema = Schema.Struct({
  archivedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
});

export function Page({ customer }: { readonly customer: typeof CustomerSchema.Type }) {
  return <span>{Option.getOrElse(customer.archivedAt, () => 'active' as unknown as never)}</span>;
}
