import { Context, Effect } from 'effect';

/**
 * An Effect v4 self-describing tag names no contract in its type arguments, so the module gives the
 * rule no generic contract to match. The supplied value explicitly identifies its own contract.
 */
export interface PrincipalLookupGateway {
  readonly lookup: (id: string) => Effect.Effect<string, Error>;
}

export class PrincipalLookup extends Context.Service<PrincipalLookup>()(
  '@app/core-runtime/auth/PrincipalLookup',
  // B4 correction: identify this contract; an opaque tag cannot exempt every unrelated interface.
  { effect: Effect.succeed({ lookup: (id: string) => Effect.succeed(id) } satisfies PrincipalLookupGateway) },
) {}
