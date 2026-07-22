import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { statusPropertyDefinitionSchema } from '../task-property-definition.ts';

export const configureStatusDefaultActionKey = 'ticketing.configureStatusDefault' as const;
export const configureStatusDefaultActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedDefinitionRevision: Schema.Finite,
  optionId: Schema.String,
  propertyDefinitionId: Schema.String,
});
export const configureStatusDefaultActionHeadersSchema = idempotentActionHeadersSchema;
export const configureStatusDefaultActionResponseSchema = Schema.Struct({
  definition: statusPropertyDefinitionSchema,
});
export const configureStatusDefaultActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: configureStatusDefaultActionResponseSchema,
});
export const configureStatusDefaultActionFailureSchemas = coreSdkOperationFailureSchemas;
export const configureStatusDefaultActionFailureSchema = coreSdkOperationFailureSchema;
export type ConfigureStatusDefaultActionPayload =
  typeof configureStatusDefaultActionPayloadSchema.Type;
export type ConfigureStatusDefaultActionResponse =
  typeof configureStatusDefaultActionResponseSchema.Type;
export type ConfigureStatusDefaultActionOutcome =
  typeof configureStatusDefaultActionOutcomeSchema.Type;
export type ConfigureStatusDefaultActionFailure =
  typeof configureStatusDefaultActionFailureSchema.Type;
export const configureStatusDefaultActionTitle = 'Configure Status Default' as const;
