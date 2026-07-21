import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';

export const configurePrincipalTimeZonePreferenceActionKey =
  'core.configurePrincipalTimeZonePreference' as const;

export const configurePrincipalTimeZonePreferenceActionPayloadSchema = Schema.Struct({
  timeZone: Schema.String,
});

export const configurePrincipalTimeZonePreferenceActionHeadersSchema =
  idempotentActionHeadersSchema;

export const configurePrincipalTimeZonePreferenceActionResponseSchema = Schema.Struct({
  principalId: Schema.String,
  source: Schema.Literal('configured'),
  timeZone: Schema.String,
});

export const configurePrincipalTimeZonePreferenceActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: configurePrincipalTimeZonePreferenceActionResponseSchema,
});

export const configurePrincipalTimeZonePreferenceActionFailureSchemas =
  coreSdkOperationFailureSchemas;
export const configurePrincipalTimeZonePreferenceActionFailureSchema =
  coreSdkOperationFailureSchema;

export type ConfigurePrincipalTimeZonePreferenceActionPayload =
  typeof configurePrincipalTimeZonePreferenceActionPayloadSchema.Type;
export type ConfigurePrincipalTimeZonePreferenceActionResponse =
  typeof configurePrincipalTimeZonePreferenceActionResponseSchema.Type;
export type ConfigurePrincipalTimeZonePreferenceActionOutcome =
  typeof configurePrincipalTimeZonePreferenceActionOutcomeSchema.Type;
export type ConfigurePrincipalTimeZonePreferenceActionFailure =
  typeof configurePrincipalTimeZonePreferenceActionFailureSchema.Type;

export const configurePrincipalTimeZonePreferenceActionTitle =
  'Configure Principal Time Zone Preference' as const;
