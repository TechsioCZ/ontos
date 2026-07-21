import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { numberPropertyDefinitionSchema } from '../task-property-definition.ts';

export const configureNumberPropertyFormatActionKey =
  'ticketing.configureNumberPropertyFormat' as const;

export const configureNumberPropertyFormatActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  format: Schema.Literals(['number', 'number_with_separators', 'percent']),
  propertyDefinitionId: Schema.String,
});

export const configureNumberPropertyFormatActionHeadersSchema = idempotentActionHeadersSchema;

export const configureNumberPropertyFormatActionResponseSchema = Schema.Struct({
  definition: numberPropertyDefinitionSchema,
});

export const configureNumberPropertyFormatActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: configureNumberPropertyFormatActionResponseSchema,
});

export const configureNumberPropertyFormatActionFailureSchemas = coreSdkOperationFailureSchemas;
export const configureNumberPropertyFormatActionFailureSchema = coreSdkOperationFailureSchema;

export type ConfigureNumberPropertyFormatActionPayload =
  typeof configureNumberPropertyFormatActionPayloadSchema.Type;
export type ConfigureNumberPropertyFormatActionResponse =
  typeof configureNumberPropertyFormatActionResponseSchema.Type;
export type ConfigureNumberPropertyFormatActionOutcome =
  typeof configureNumberPropertyFormatActionOutcomeSchema.Type;
export type ConfigureNumberPropertyFormatActionFailure =
  typeof configureNumberPropertyFormatActionFailureSchema.Type;

export const configureNumberPropertyFormatActionTitle = 'Configure Number Property Format' as const;
