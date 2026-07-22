import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { multiSelectOptionSchema } from '../task-property-definition.ts';

export const updateMultiSelectOptionActionKey = 'ticketing.updateMultiSelectOption' as const;
export const updateMultiSelectOptionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  color: Schema.String,
  expectedRevision: Schema.Finite,
  name: Schema.String,
  optionId: Schema.String,
  propertyDefinitionId: Schema.String,
});
export const updateMultiSelectOptionActionHeadersSchema = idempotentActionHeadersSchema;
export const updateMultiSelectOptionActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  option: multiSelectOptionSchema,
});
export const updateMultiSelectOptionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateMultiSelectOptionActionResponseSchema,
});
export const updateMultiSelectOptionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateMultiSelectOptionActionFailureSchema = coreSdkOperationFailureSchema;
export type UpdateMultiSelectOptionActionPayload =
  typeof updateMultiSelectOptionActionPayloadSchema.Type;
export type UpdateMultiSelectOptionActionResponse =
  typeof updateMultiSelectOptionActionResponseSchema.Type;
export type UpdateMultiSelectOptionActionOutcome =
  typeof updateMultiSelectOptionActionOutcomeSchema.Type;
export type UpdateMultiSelectOptionActionFailure =
  typeof updateMultiSelectOptionActionFailureSchema.Type;
export const updateMultiSelectOptionActionTitle = 'Update Multi-select Option' as const;
