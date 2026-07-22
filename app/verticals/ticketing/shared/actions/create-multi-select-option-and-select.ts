import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { multiSelectOptionSchema } from '../task-property-definition.ts';
import { multiSelectPropertyValueSchema } from '../task-property-workspace.ts';

export const createMultiSelectOptionAndSelectActionKey =
  'ticketing.createMultiSelectOptionAndSelect' as const;
export const createMultiSelectOptionAndSelectActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  color: Schema.String,
  expectedDefinitionRevision: Schema.Finite,
  expectedValueRevision: Schema.Finite,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});
export const createMultiSelectOptionAndSelectActionHeadersSchema = idempotentActionHeadersSchema;
export const createMultiSelectOptionAndSelectActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  option: multiSelectOptionSchema,
  taskRevision: Schema.Finite,
  value: multiSelectPropertyValueSchema,
});
export const createMultiSelectOptionAndSelectActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createMultiSelectOptionAndSelectActionResponseSchema,
});
export const createMultiSelectOptionAndSelectActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createMultiSelectOptionAndSelectActionFailureSchema = coreSdkOperationFailureSchema;
export type CreateMultiSelectOptionAndSelectActionPayload =
  typeof createMultiSelectOptionAndSelectActionPayloadSchema.Type;
export type CreateMultiSelectOptionAndSelectActionResponse =
  typeof createMultiSelectOptionAndSelectActionResponseSchema.Type;
export type CreateMultiSelectOptionAndSelectActionOutcome =
  typeof createMultiSelectOptionAndSelectActionOutcomeSchema.Type;
export type CreateMultiSelectOptionAndSelectActionFailure =
  typeof createMultiSelectOptionAndSelectActionFailureSchema.Type;
export const createMultiSelectOptionAndSelectActionTitle =
  'Create Multi-select Option And Select' as const;
