// expect-count: 6
import { Schema } from '@modern-js/plugin-bff/effect-client';

export const ApiKeyIssueResponseSchema = Schema.Struct({
  keyId: Schema.String,
  secret: Schema.String.check(Schema.isMinLength(1)),
});

export const SignInPayloadSchema = Schema.Struct({
  email: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.String.check(Schema.isMinLength(1)),
});

export class GatewayCredentials extends Schema.Class<GatewayCredentials>('GatewayCredentials')({
  issuer: Schema.String,
  preSharedKey: Schema.NonEmptyString,
  privateJwk: Schema.optional(Schema.Trim),
}) {}

export const ProviderRecordSchema = Schema.Struct({
  clientSecret: Schema.NullOr(Schema.String),
  displayName: Schema.String,
  refreshToken: Schema.optionalKey(Schema.String.annotate({ description: 'oauth' })),
});
