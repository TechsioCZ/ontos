import { Schema } from '@modern-js/plugin-bff/effect-client';

export const createTicketActionKey = 'ticketing.createTicket' as const;

export const createTicketActionPayloadSchema = Schema.Struct({
  summary: Schema.String,
  targetResourceId: Schema.String,
});

export const createTicketActionHeadersSchema = Schema.Struct({
  'Idempotency-Key': Schema.optional(Schema.String),
  'x-ontos-operation-context': Schema.optional(Schema.String),
});

export const createTicketActionResponseSchema = Schema.Struct({
  accepted: Schema.Literal(true),
  actionKey: Schema.Literal(createTicketActionKey),
  message: Schema.String,
  targetResourceId: Schema.String,
});

export const createTicketActionOutcomeSchema = Schema.Union([
  Schema.Struct({
    actionInvocationId: Schema.optional(Schema.String),
    ok: Schema.Literal(true),
    response: createTicketActionResponseSchema,
  }),
  Schema.Struct({
    code: Schema.optional(Schema.String),
    errorTag: Schema.String,
    httpStatus: Schema.Finite,
    message: Schema.String,
    ok: Schema.Literal(false),
  }),
]);

export type CreateTicketActionPayload = typeof createTicketActionPayloadSchema.Type;
export type CreateTicketActionResponse = typeof createTicketActionResponseSchema.Type;
export type CreateTicketActionOutcome = typeof createTicketActionOutcomeSchema.Type;

export const createTicketActionTitle = 'Create Ticket' as const;
