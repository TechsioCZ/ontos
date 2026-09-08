import { Effect, Layer } from 'effect';
import { PrincipalResolver } from './generic-tag.ts';

/** The tag lives next door; this module wires the contract into the Layer graph. */
export interface PrincipalResolverRepositoryAccess {
  readonly resolve: (id: string) => Effect.Effect<string, Error>;
}

export const PrincipalResolverLive = Layer.effect(
  PrincipalResolver,
  // B4 correction: merely wiring an unrelated imported tag cannot prove this contract is provided.
  Effect.succeed({ resolve: (id: string) => Effect.succeed(id) } satisfies PrincipalResolverRepositoryAccess),
);
