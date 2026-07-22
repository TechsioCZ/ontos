import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { statusGroupKeySchema, statusOptionSchema } from '../task-property-definition.ts';

export const createStatusOptionActionKey = 'ticketing.createStatusOption' as const;
export const createStatusOptionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  color: Schema.String,
  expectedDefinitionRevision: Schema.Finite,
  group: statusGroupKeySchema,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
});
export const createStatusOptionActionHeadersSchema = idempotentActionHeadersSchema;
export const createStatusOptionActionResponseSchema = Schema.Struct({
  definitionRevision: Schema.Finite,
  option: statusOptionSchema,
});
export const createStatusOptionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createStatusOptionActionResponseSchema,
});
export const createStatusOptionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createStatusOptionActionFailureSchema = coreSdkOperationFailureSchema;
export type CreateStatusOptionActionPayload = typeof createStatusOptionActionPayloadSchema.Type;
export type CreateStatusOptionActionResponse = typeof createStatusOptionActionResponseSchema.Type;
export type CreateStatusOptionActionOutcome = typeof createStatusOptionActionOutcomeSchema.Type;
export type CreateStatusOptionActionFailure = typeof createStatusOptionActionFailureSchema.Type;
export const createStatusOptionActionTitle = 'Create Status Option' as const;
