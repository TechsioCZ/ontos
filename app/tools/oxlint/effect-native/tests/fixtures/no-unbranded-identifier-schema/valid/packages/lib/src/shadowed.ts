// `Schema` here is a local shadow, not the effect namespace.
import { Schema } from 'effect';

export function build(Schema: { readonly String: unknown }): unknown {
  const Local = {
    Struct: (fields: unknown) => fields,
    String: Schema.String,
  };
  return Local.Struct({ tenantId: Local.String, principalId: Schema.String });
}

export const Real = Schema.Struct({ name: Schema.String });
