import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { selectOptionSchema } from '../task-property-definition.ts';

export const createSelectOptionActionKey = 'ticketing.createSelectOption' as const;
export const createSelectOptionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  color: Schema.String,
  expectedDefinitionRevision: Schema.Finite,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
});
export const createSelectOptionActionHeadersSchema = idempotentActionHeadersSchema;
export const createSelectOptionActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  option: selectOptionSchema,
});
export const createSelectOptionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createSelectOptionActionResponseSchema,
});
export const createSelectOptionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createSelectOptionActionFailureSchema = coreSdkOperationFailureSchema;
export type CreateSelectOptionActionPayload = typeof createSelectOptionActionPayloadSchema.Type;
export type CreateSelectOptionActionResponse = typeof createSelectOptionActionResponseSchema.Type;
export type CreateSelectOptionActionOutcome = typeof createSelectOptionActionOutcomeSchema.Type;
export type CreateSelectOptionActionFailure = typeof createSelectOptionActionFailureSchema.Type;
export const createSelectOptionActionTitle = 'Create Select Option' as const;
