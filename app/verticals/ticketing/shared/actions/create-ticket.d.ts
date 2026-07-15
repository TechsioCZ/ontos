import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const createTicketActionKey: 'ticketing.createTicket';
export declare const createTicketActionPayloadSchema: Schema.Struct<{
  readonly summary: Schema.String;
  readonly targetResourceId: Schema.String;
}>;
export declare const createTicketActionHeadersSchema: Schema.Struct<{
  readonly 'Idempotency-Key': Schema.optional<Schema.String>;
  readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>;
export declare const createTicketActionResponseSchema: Schema.Struct<{
  readonly accepted: Schema.Literal<true>;
  readonly actionKey: Schema.Literal<'ticketing.createTicket'>;
  readonly message: Schema.String;
  readonly targetResourceId: Schema.String;
}>;
export declare const createTicketActionOutcomeSchema: Schema.Struct<{
  readonly actionInvocationId: Schema.optional<Schema.String>;
  readonly ok: Schema.Literal<true>;
  readonly response: Schema.Struct<{
    readonly accepted: Schema.Literal<true>;
    readonly actionKey: Schema.Literal<'ticketing.createTicket'>;
    readonly message: Schema.String;
    readonly targetResourceId: Schema.String;
  }>;
}>;
export declare const createTicketActionFailureSchema: Schema.Struct<{
  readonly code: Schema.optional<Schema.String>;
  readonly errorTag: Schema.String;
  readonly httpStatus: Schema.Finite;
  readonly message: Schema.String;
  readonly ok: Schema.Literal<false>;
  readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>;
export type CreateTicketActionPayload = typeof createTicketActionPayloadSchema.Type;
export type CreateTicketActionResponse = typeof createTicketActionResponseSchema.Type;
export type CreateTicketActionOutcome = typeof createTicketActionOutcomeSchema.Type;
export type CreateTicketActionFailure = typeof createTicketActionFailureSchema.Type;
export declare const createTicketActionTitle: 'Create Ticket';
