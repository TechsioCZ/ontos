// expect-count: 1
import { gen } from 'effect/Effect';

/** The member itself is destructured, so no `Effect.` prefix ever appears in the body. */
export const makeOutboxProcessor = (dependencies: OutboxProcessorDependencies) =>
  gen(function* () {
    const clock = yield* Clock;
    return { clock, dependencies };
  });

export const createProcessorKey = (tenant: string, module: string) => `${tenant}:${module}`;
