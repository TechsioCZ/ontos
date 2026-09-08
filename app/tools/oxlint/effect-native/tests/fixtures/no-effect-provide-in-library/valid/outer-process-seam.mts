// D tier: the single outer process entrypoint seam. One program, one Layer, one run at module top level.
import { Effect, Layer } from "effect";

declare const verifyDatabase: Effect.Effect<{ readonly tableCount: number }, never, never>;
declare const CoreDatabaseLive: Layer.Layer<never, never, never>;
declare const DatabaseConfigLive: Layer.Layer<never, never, never>;

const DatabaseRuntimeLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));

const result = await Effect.runPromise(Effect.provide(verifyDatabase, DatabaseRuntimeLive));

export const forked = Effect.runFork(verifyDatabase.pipe(Effect.provide(DatabaseRuntimeLive)));

console.log(result.tableCount);
