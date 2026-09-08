// expect-count: 1
import * as Fx from 'effect/Effect';

/** Namespace import of an `effect/*` submodule under a local alias. */
export const makeOutboxRuntime = (dependencies: OutboxDependencies) =>
  Fx.gen(function* () {
    const clock = yield* Clock;
    return { clock, dependencies };
  });

export const createOutboxKey = (tenant: string, module: string) => `${tenant}:${module}`;
