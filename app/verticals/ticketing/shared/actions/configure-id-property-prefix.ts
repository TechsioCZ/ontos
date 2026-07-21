import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { idPropertyDefinitionSchema } from '../task-property-definition.ts';
import type { IdPropertyDefinition } from '../task-property-definition.ts';

export const configureIdPropertyPrefixActionKey = 'ticketing.configureIdPropertyPrefix' as const;

export const configureIdPropertyPrefixActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  prefix: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const configureIdPropertyPrefixActionHeadersSchema = idempotentActionHeadersSchema;
export const configureIdPropertyPrefixActionResponseSchema = Schema.Struct({
  definition: idPropertyDefinitionSchema,
});
export const configureIdPropertyPrefixActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: configureIdPropertyPrefixActionResponseSchema,
});
export const configureIdPropertyPrefixActionFailureSchema = coreSdkOperationFailureSchema;
export const configureIdPropertyPrefixActionFailureSchemas = coreSdkOperationFailureSchemas;

export type ConfigureIdPropertyPrefixActionPayload =
  typeof configureIdPropertyPrefixActionPayloadSchema.Type;
export interface ConfigureIdPropertyPrefixActionResponse {
  readonly definition: IdPropertyDefinition;
}
export type ConfigureIdPropertyPrefixActionOutcome =
  typeof configureIdPropertyPrefixActionOutcomeSchema.Type;
export type ConfigureIdPropertyPrefixActionFailure =
  typeof configureIdPropertyPrefixActionFailureSchema.Type;

export const configureIdPropertyPrefixActionTitle = 'Configure ID Property Prefix' as const;
