import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { statusGroupKeySchema, statusOptionSchema } from '../task-property-definition.ts';

export const updateStatusOptionActionKey = 'ticketing.updateStatusOption' as const;
export const updateStatusOptionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  color: Schema.String,
  expectedDefinitionRevision: Schema.Finite,
  expectedOptionRevision: Schema.Finite,
  group: statusGroupKeySchema,
  name: Schema.String,
  optionId: Schema.String,
  position: Schema.Finite,
  propertyDefinitionId: Schema.String,
});
export const updateStatusOptionActionHeadersSchema = idempotentActionHeadersSchema;
export const updateStatusOptionActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  option: statusOptionSchema,
});
export const updateStatusOptionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateStatusOptionActionResponseSchema,
});
export const updateStatusOptionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateStatusOptionActionFailureSchema = coreSdkOperationFailureSchema;
export type UpdateStatusOptionActionPayload = typeof updateStatusOptionActionPayloadSchema.Type;
export type UpdateStatusOptionActionResponse = typeof updateStatusOptionActionResponseSchema.Type;
export type UpdateStatusOptionActionOutcome = typeof updateStatusOptionActionOutcomeSchema.Type;
export type UpdateStatusOptionActionFailure = typeof updateStatusOptionActionFailureSchema.Type;
export const updateStatusOptionActionTitle = 'Update Status Option' as const;
