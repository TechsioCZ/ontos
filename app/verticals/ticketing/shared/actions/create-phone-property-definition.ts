import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { phonePropertyDefinitionSchema } from '../task-property-definition.ts';

export const createPhonePropertyDefinitionActionKey =
  'ticketing.createPhonePropertyDefinition' as const;

export const createPhonePropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createPhonePropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createPhonePropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: phonePropertyDefinitionSchema,
});

export const createPhonePropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createPhonePropertyDefinitionActionResponseSchema,
});

export const createPhonePropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createPhonePropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type CreatePhonePropertyDefinitionActionPayload =
  typeof createPhonePropertyDefinitionActionPayloadSchema.Type;
export type CreatePhonePropertyDefinitionActionResponse =
  typeof createPhonePropertyDefinitionActionResponseSchema.Type;
export type CreatePhonePropertyDefinitionActionOutcome =
  typeof createPhonePropertyDefinitionActionOutcomeSchema.Type;
export type CreatePhonePropertyDefinitionActionFailure =
  typeof createPhonePropertyDefinitionActionFailureSchema.Type;

export const createPhonePropertyDefinitionActionTitle = 'Create Phone Property Definition' as const;
