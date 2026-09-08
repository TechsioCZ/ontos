// A root namespace import of `effect` binds every Effect namespace under one local name.
// `Effect.Service` is a library type here, not an injected application dependency.
import * as Effect from "effect";

export const describe = (
  service: Effect.Effect.Service<never>,
  program: Effect.Effect.Effect<string>,
) => [service, program];
