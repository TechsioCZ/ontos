import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { taskCreationSchema } from '../task-collection.ts';
import type { TaskCreation } from '../task-collection.ts';

export const duplicateTaskActionKey = 'ticketing.duplicateTask' as const;
export const duplicateTaskActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  sourceTaskId: Schema.String,
});
export const duplicateTaskActionHeadersSchema = idempotentActionHeadersSchema;
export const duplicateTaskActionResponseSchema = taskCreationSchema;
export const duplicateTaskActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: duplicateTaskActionResponseSchema,
});
export const duplicateTaskActionFailureSchema = coreSdkOperationFailureSchema;
export const duplicateTaskActionFailureSchemas = coreSdkOperationFailureSchemas;

export type DuplicateTaskActionPayload = typeof duplicateTaskActionPayloadSchema.Type;
export type DuplicateTaskActionResponse = TaskCreation;
export type DuplicateTaskActionOutcome = typeof duplicateTaskActionOutcomeSchema.Type;
export type DuplicateTaskActionFailure = typeof duplicateTaskActionFailureSchema.Type;
export const duplicateTaskActionTitle = 'Duplicate Task' as const;
