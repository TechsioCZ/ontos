import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';
import { taskCollectionAggregateSchema } from '../task-collection.ts';
import type { TaskCollectionAggregate } from '../task-collection.ts';

export const createTicketActionKey = 'ticketing.createTicket' as const;

export const createTicketActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
});

export const createTicketActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const createTicketActionResponseSchema = taskCollectionAggregateSchema;

export const createTicketActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createTicketActionResponseSchema,
});

export const createTicketActionFailureSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  errorTag: Schema.String,
  httpStatus: Schema.Finite,
  message: Schema.String,
  ok: Schema.Literal(false),
  state: Schema.optional(Schema.Json),
}).pipe(HttpApiSchema.status(409));

export type CreateTicketActionPayload = typeof createTicketActionPayloadSchema.Type;
export type CreateTicketActionResponse = TaskCollectionAggregate;
export type CreateTicketActionOutcome = typeof createTicketActionOutcomeSchema.Type;
export type CreateTicketActionFailure = typeof createTicketActionFailureSchema.Type;

export const createTicketActionTitle = 'Create Task Collection' as const;
