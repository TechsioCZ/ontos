import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { taskCreationSchema } from '../task-collection.ts';
import type { TaskCreation } from '../task-collection.ts';

export const createTaskActionKey = 'ticketing.createTask' as const;

export const createTaskActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
});

export const createTaskActionHeadersSchema = idempotentActionHeadersSchema;

export const createTaskActionResponseSchema = taskCreationSchema;

export const createTaskActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createTaskActionResponseSchema,
});

export const createTaskActionFailureSchema = coreSdkOperationFailureSchema;
export const createTaskActionFailureSchemas = coreSdkOperationFailureSchemas;

export type CreateTaskActionPayload = typeof createTaskActionPayloadSchema.Type;
export type CreateTaskActionResponse = TaskCreation;
export type CreateTaskActionOutcome = typeof createTaskActionOutcomeSchema.Type;
export type CreateTaskActionFailure = typeof createTaskActionFailureSchema.Type;

export const createTaskActionTitle = 'Create Task' as const;
