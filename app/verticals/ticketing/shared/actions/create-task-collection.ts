import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';
import { taskCollectionCreationSchema } from '../task-collection.ts';
import type { TaskCollectionCreation } from '../task-collection.ts';

export const createTaskCollectionActionKey = 'ticketing.createTaskCollection' as const;

export const createTaskCollectionActionPayloadSchema = Schema.Struct({});

export const createTaskCollectionActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const createTaskCollectionActionResponseSchema = taskCollectionCreationSchema;

export const createTaskCollectionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createTaskCollectionActionResponseSchema,
});

export const createTaskCollectionActionFailureSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  errorTag: Schema.String,
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
}).pipe(HttpApiSchema.status(409));

export type CreateTaskCollectionActionPayload = typeof createTaskCollectionActionPayloadSchema.Type;
export type CreateTaskCollectionActionResponse = TaskCollectionCreation;
export type CreateTaskCollectionActionOutcome = typeof createTaskCollectionActionOutcomeSchema.Type;
export type CreateTaskCollectionActionFailure = typeof createTaskCollectionActionFailureSchema.Type;

export const createTaskCollectionActionTitle = 'Create Task Collection' as const;
