// expect-count: 5
import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';

// The BFF barrel re-exports `effect/Schema` verbatim; contracts imported this way count.
// 1 principalId, 2 authBindingId (spread field bag), 3 tenantId, 4 targetPrincipalId
const apiKeyStatusFields = {
  authBindingId: Schema.String.check(Schema.isUUID()),
  expectedStatus: Schema.Literals(['active', 'disabled']),
};

export const SetApiKeyStatusPayloadSchema = Schema.Union([
  Schema.Struct({
    ...apiKeyStatusFields,
    principalId: Schema.String.check(Schema.isUUID()),
    reason: Schema.String,
  }),
  Schema.Struct({
    ...apiKeyStatusFields,
    reason: Schema.String,
  }),
]);

export const ImpersonationSchema = Schema.Struct({
  tenantId: Schema.String,
  targetPrincipalId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  displayName: Schema.String,
});

// 5 — a directly-passed (never spread) `*Fields` bag handed to a TaggedError.
const errorFields = { correlationId: Schema.String, reason: Schema.String };

export class GatewayRejectedError extends Schema.TaggedError<GatewayRejectedError>()(
  'GatewayRejectedError',
  errorFields,
  HttpApiSchema.annotations({ status: 409 }),
) {}
