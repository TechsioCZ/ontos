import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { checkboxPropertyDefinitionSchema } from '../task-property-definition.ts';

export { checkboxPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createCheckboxPropertyDefinitionActionKey =
  'ticketing.createCheckboxPropertyDefinition' as const;

export const createCheckboxPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createCheckboxPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createCheckboxPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: checkboxPropertyDefinitionSchema,
});

export const createCheckboxPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createCheckboxPropertyDefinitionActionResponseSchema,
});

export const createCheckboxPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createCheckboxPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type CreateCheckboxPropertyDefinitionActionPayload =
  typeof createCheckboxPropertyDefinitionActionPayloadSchema.Type;
export type CreateCheckboxPropertyDefinitionActionResponse =
  typeof createCheckboxPropertyDefinitionActionResponseSchema.Type;
export type CreateCheckboxPropertyDefinitionActionOutcome =
  typeof createCheckboxPropertyDefinitionActionOutcomeSchema.Type;
export type CreateCheckboxPropertyDefinitionActionFailure =
  typeof createCheckboxPropertyDefinitionActionFailureSchema.Type;

export const createCheckboxPropertyDefinitionActionTitle =
  'Create Checkbox Property Definition' as const;
