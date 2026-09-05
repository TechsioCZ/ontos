import { Schema } from 'effect';

export const Good = Schema.Struct({ createdAt: Schema.DateTimeUtc });

// A parameter that shadows the import is not Effect's Schema, at any depth.
export function build(Schema: { Struct: (fields: unknown) => unknown; String: unknown }): unknown {
  const inner = () => Schema.Struct({ createdAt: Schema.String, expiresAt: Schema.String });
  return inner();
}

// A block-scoped shadow does the same.
export function rebuild(): unknown {
  {
    const Schema = { Struct: (fields: unknown) => fields, String: 'string' as const };
    return Schema.Struct({ revokedAt: Schema.String });
  }
}
