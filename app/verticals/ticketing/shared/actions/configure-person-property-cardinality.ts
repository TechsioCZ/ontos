import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { personPropertyDefinitionSchema } from '../task-property-definition.ts';

export const configurePersonPropertyCardinalityActionKey =
  'ticketing.configurePersonPropertyCardinality' as const;

export const configurePersonPropertyCardinalityActionPayloadSchema = Schema.Struct({
  cardinality: Schema.Literals(['one', 'unlimited']),
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export const configurePersonPropertyCardinalityActionHeadersSchema = idempotentActionHeadersSchema;

export const configurePersonPropertyCardinalityActionResponseSchema = Schema.Struct({
  definition: personPropertyDefinitionSchema,
});

export const configurePersonPropertyCardinalityActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: configurePersonPropertyCardinalityActionResponseSchema,
});

export const configurePersonPropertyCardinalityActionFailureSchemas =
  coreSdkOperationFailureSchemas;
export const configurePersonPropertyCardinalityActionFailureSchema = coreSdkOperationFailureSchema;

export type ConfigurePersonPropertyCardinalityActionPayload =
  typeof configurePersonPropertyCardinalityActionPayloadSchema.Type;
export type ConfigurePersonPropertyCardinalityActionResponse =
  typeof configurePersonPropertyCardinalityActionResponseSchema.Type;
export type ConfigurePersonPropertyCardinalityActionOutcome =
  typeof configurePersonPropertyCardinalityActionOutcomeSchema.Type;
export type ConfigurePersonPropertyCardinalityActionFailure =
  typeof configurePersonPropertyCardinalityActionFailureSchema.Type;

export const configurePersonPropertyCardinalityActionTitle =
  'Configure Person Property Cardinality' as const;
