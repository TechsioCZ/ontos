import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { checkboxPropertyDefinitionSchema } from './create-checkbox-property-definition.ts';

export const configureTaskPropertyDefinitionActionKey =
  'ticketing.configureTaskPropertyDefinition' as const;

export const configureTaskPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const configureTaskPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const configureTaskPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: checkboxPropertyDefinitionSchema,
});

export const configureTaskPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: configureTaskPropertyDefinitionActionResponseSchema,
});

export const configureTaskPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const configureTaskPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type ConfigureTaskPropertyDefinitionActionPayload =
  typeof configureTaskPropertyDefinitionActionPayloadSchema.Type;
export type ConfigureTaskPropertyDefinitionActionResponse =
  typeof configureTaskPropertyDefinitionActionResponseSchema.Type;
export type ConfigureTaskPropertyDefinitionActionOutcome =
  typeof configureTaskPropertyDefinitionActionOutcomeSchema.Type;
export type ConfigureTaskPropertyDefinitionActionFailure =
  typeof configureTaskPropertyDefinitionActionFailureSchema.Type;

export const configureTaskPropertyDefinitionActionTitle =
  'Configure Task Property Definition' as const;
