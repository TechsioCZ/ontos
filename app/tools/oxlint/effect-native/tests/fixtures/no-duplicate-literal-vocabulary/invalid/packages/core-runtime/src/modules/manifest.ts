// expect-count: 2
// Root barrel access (`import * as Effect from "effect"` -> `Effect.Schema.Literals`).
import * as Effect from 'effect';

export const IdempotencySchema = Effect.Schema.Literals(['optional', 'required']);

export const OntosActionContractSchema = Effect.Schema.Struct({
  // Same vocabulary as `IdempotencySchema`, written out again.
  idempotency: Effect.Schema.Literals(['required', 'optional']),
  legalEntityScope: Effect.Schema.Literals(['forbidden', 'optional', 'required']),
});

export const OntosApiContractSchema = Effect.Schema.Struct({
  idempotency: Effect.Schema.Literals(['optional', 'required']),
});
