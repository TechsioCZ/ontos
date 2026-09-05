import { Schema } from 'effect';

export const Ok = Schema.OptionFromNullOr(Schema.String);

// A parameter and a block-scoped const both shadow the import: neither is Effect's Schema.
export function build(Schema: { readonly NullOr: (value: string) => string }) {
  return Schema.NullOr('x');
}

export function local() {
  const Schema = { NullOr: (value: string) => value };
  return Schema.NullOr('y');
}
