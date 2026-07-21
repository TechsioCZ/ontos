import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { selectOptionSchema } from '../task-property-definition.ts';
import { selectPropertyValueSchema } from '../task-property-workspace.ts';

export const createSelectOptionAndSelectActionKey =
  'ticketing.createSelectOptionAndSelect' as const;
export const createSelectOptionAndSelectActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  color: Schema.String,
  expectedDefinitionRevision: Schema.Finite,
  expectedValueRevision: Schema.Finite,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});
export const createSelectOptionAndSelectActionHeadersSchema = idempotentActionHeadersSchema;
export const createSelectOptionAndSelectActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  option: selectOptionSchema,
  taskRevision: Schema.Finite,
  value: selectPropertyValueSchema,
});
export const createSelectOptionAndSelectActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createSelectOptionAndSelectActionResponseSchema,
});
export const createSelectOptionAndSelectActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createSelectOptionAndSelectActionFailureSchema = coreSdkOperationFailureSchema;
export type CreateSelectOptionAndSelectActionPayload =
  typeof createSelectOptionAndSelectActionPayloadSchema.Type;
export type CreateSelectOptionAndSelectActionResponse =
  typeof createSelectOptionAndSelectActionResponseSchema.Type;
export type CreateSelectOptionAndSelectActionOutcome =
  typeof createSelectOptionAndSelectActionOutcomeSchema.Type;
export type CreateSelectOptionAndSelectActionFailure =
  typeof createSelectOptionAndSelectActionFailureSchema.Type;
export const createSelectOptionAndSelectActionTitle = 'Create Select Option And Select' as const;
