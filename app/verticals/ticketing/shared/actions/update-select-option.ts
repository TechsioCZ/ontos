import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { selectOptionSchema } from '../task-property-definition.ts';

export const updateSelectOptionActionKey = 'ticketing.updateSelectOption' as const;
export const updateSelectOptionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  color: Schema.String,
  expectedRevision: Schema.Finite,
  name: Schema.String,
  optionId: Schema.String,
  propertyDefinitionId: Schema.String,
});
export const updateSelectOptionActionHeadersSchema = idempotentActionHeadersSchema;
export const updateSelectOptionActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  option: selectOptionSchema,
});
export const updateSelectOptionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateSelectOptionActionResponseSchema,
});
export const updateSelectOptionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateSelectOptionActionFailureSchema = coreSdkOperationFailureSchema;
export type UpdateSelectOptionActionPayload = typeof updateSelectOptionActionPayloadSchema.Type;
export type UpdateSelectOptionActionResponse = typeof updateSelectOptionActionResponseSchema.Type;
export type UpdateSelectOptionActionOutcome = typeof updateSelectOptionActionOutcomeSchema.Type;
export type UpdateSelectOptionActionFailure = typeof updateSelectOptionActionFailureSchema.Type;
export const updateSelectOptionActionTitle = 'Update Select Option' as const;
