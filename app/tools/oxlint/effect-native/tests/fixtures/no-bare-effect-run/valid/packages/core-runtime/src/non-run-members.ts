import { Effect } from 'effect';

/** `Effect.runtime` is not a run entry point, and combinators keep the code an Effect. */
export const currentRuntime = Effect.runtime<never>();

export const doubled = Effect.map(Effect.succeed(1), (value) => value * 2);

export const adapters = { runPromise: async (): Promise<void> => undefined, runSync: (): void => undefined };

export const chosen = adapters.runPromise;
