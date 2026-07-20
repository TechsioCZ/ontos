import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { taskCollectionCreationSchema } from '../task-collection.ts';
import type { TaskCollectionCreation } from '../task-collection.ts';

export const createTaskCollectionActionKey = 'ticketing.createTaskCollection' as const;

export const createTaskCollectionActionPayloadSchema = Schema.Struct({});

export const createTaskCollectionActionHeadersSchema = idempotentActionHeadersSchema;

export const createTaskCollectionActionResponseSchema = taskCollectionCreationSchema;

export const createTaskCollectionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createTaskCollectionActionResponseSchema,
});

export const createTaskCollectionActionFailureSchema = coreSdkOperationFailureSchema;
export const createTaskCollectionActionFailureSchemas = coreSdkOperationFailureSchemas;

export type CreateTaskCollectionActionPayload = typeof createTaskCollectionActionPayloadSchema.Type;
export type CreateTaskCollectionActionResponse = TaskCollectionCreation;
export type CreateTaskCollectionActionOutcome = typeof createTaskCollectionActionOutcomeSchema.Type;
export type CreateTaskCollectionActionFailure = typeof createTaskCollectionActionFailureSchema.Type;

export const createTaskCollectionActionTitle = 'Create Task Collection' as const;
