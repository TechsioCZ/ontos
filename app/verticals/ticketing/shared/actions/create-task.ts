import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';
import { taskCreationSchema } from '../task-collection.ts';
import type { TaskCreation } from '../task-collection.ts';

export const createTaskActionKey = 'ticketing.createTask' as const;

export const createTaskActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
});

export const createTaskActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const createTaskActionResponseSchema = taskCreationSchema;

export const createTaskActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createTaskActionResponseSchema,
});

export const createTaskActionFailureSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  errorTag: Schema.String,
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
}).pipe(HttpApiSchema.status(409));

export type CreateTaskActionPayload = typeof createTaskActionPayloadSchema.Type;
export type CreateTaskActionResponse = TaskCreation;
export type CreateTaskActionOutcome = typeof createTaskActionOutcomeSchema.Type;
export type CreateTaskActionFailure = typeof createTaskActionFailureSchema.Type;

export const createTaskActionTitle = 'Create Task' as const;
