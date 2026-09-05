import { Schema } from '@modern-js/plugin-bff/effect-client';

// Redacted through the Modern.js BFF barrel re-export of `effect/Schema`.
export const ApiKeyIssueResponseSchema = Schema.Struct({
  keyId: Schema.String,
  secret: Schema.Redacted(Schema.String),
});

// A plain object literal is not a schema field bag: the value is a runtime string, not a codec.
export const defaults = {
  connectionString: buildConnectionString(),
  password: '',
  secret: process.env.AUTH_SECRET ?? '',
};

function buildConnectionString(): string {
  return 'postgres://localhost';
}

// A type-position `Schema.Codec<...>` is a type, never a reported field.
export type SignInPayload = Schema.Codec<{ readonly password: Redacted }>;

export type Redacted = { readonly _tag: 'Redacted' };
