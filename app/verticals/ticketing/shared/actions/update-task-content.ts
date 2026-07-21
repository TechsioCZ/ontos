import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';

export const updateTaskContentActionKey = 'ticketing.updateTaskContent' as const;

export const updateTaskContentActionPayloadSchema = Schema.Struct({
  canvas: Schema.Json,
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  taskId: Schema.String,
  title: Schema.String,
});

export const updateTaskContentActionHeadersSchema = idempotentActionHeadersSchema;

export const updateTaskContentActionResponseSchema = Schema.Struct({
  canvas: Schema.Json,
  changedComponents: Schema.Array(Schema.Literal('title', 'canvas')),
  taskId: Schema.String,
  taskRevision: Schema.Finite,
  title: Schema.String,
});

export const updateTaskContentActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateTaskContentActionResponseSchema,
});

export const updateTaskContentActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateTaskContentActionFailureSchema = coreSdkOperationFailureSchema;

export type UpdateTaskContentActionPayload = typeof updateTaskContentActionPayloadSchema.Type;
export type UpdateTaskContentActionResponse = typeof updateTaskContentActionResponseSchema.Type;
export type UpdateTaskContentActionOutcome = typeof updateTaskContentActionOutcomeSchema.Type;
export type UpdateTaskContentActionFailure = typeof updateTaskContentActionFailureSchema.Type;

export const updateTaskContentActionTitle = 'Update Task Content' as const;
