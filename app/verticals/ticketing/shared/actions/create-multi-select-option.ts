import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { multiSelectOptionSchema } from '../task-property-definition.ts';

export const createMultiSelectOptionActionKey = 'ticketing.createMultiSelectOption' as const;
export const createMultiSelectOptionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  color: Schema.String,
  expectedDefinitionRevision: Schema.Finite,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
});
export const createMultiSelectOptionActionHeadersSchema = idempotentActionHeadersSchema;
export const createMultiSelectOptionActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  option: multiSelectOptionSchema,
});
export const createMultiSelectOptionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createMultiSelectOptionActionResponseSchema,
});
export const createMultiSelectOptionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createMultiSelectOptionActionFailureSchema = coreSdkOperationFailureSchema;
export type CreateMultiSelectOptionActionPayload =
  typeof createMultiSelectOptionActionPayloadSchema.Type;
export type CreateMultiSelectOptionActionResponse =
  typeof createMultiSelectOptionActionResponseSchema.Type;
export type CreateMultiSelectOptionActionOutcome =
  typeof createMultiSelectOptionActionOutcomeSchema.Type;
export type CreateMultiSelectOptionActionFailure =
  typeof createMultiSelectOptionActionFailureSchema.Type;
export const createMultiSelectOptionActionTitle = 'Create Multi-select Option' as const;
