/** No effect import at all: a local namespace object that happens to expose run* members. */
const Effect = { runPromise: async (): Promise<number> => 1, runSync: (): number => 1 };

export const value = Effect.runSync();

export const promised = Effect.runPromise();
