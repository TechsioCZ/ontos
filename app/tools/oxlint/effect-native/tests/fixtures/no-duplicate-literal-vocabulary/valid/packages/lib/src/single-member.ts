// Single-literal discriminants are union branch tags, not closed vocabularies (`minMembers: 2`).
import { Schema } from 'effect';

export const RevokePayload = Schema.Struct({
  newStatus: Schema.Literal('revoked'),
  retryable: Schema.Literal(true),
});

export const RevokeEcho = Schema.Struct({
  newStatus: Schema.Literal('revoked'),
  retryable: Schema.Literal(true),
});

export const RevokeSet = Schema.Struct({ newStatus: Schema.Literals(['revoked']) });
export const RevokeSetAgain = Schema.Struct({ newStatus: Schema.Literals(['revoked']) });
