// expect-count: 4
import { Effect, Layer } from 'effect';

declare const CorePersistenceLive: Layer.Layer<never>;
declare const ActionRuntimeLive: Layer.Layer<never>;
declare const ApiKeyServiceLive: Layer.Layer<never>;
declare const loadDatabaseConfig: () => Effect.Effect<never>;
declare const DatabaseConfig: never;

// Not a startup root: every one of these is reported.
export const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);

export const apiKeyServiceLive = ApiKeyServiceLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);

export const databaseLive = Layer.orDie(Layer.effect(DatabaseConfig, loadDatabaseConfig()));

export const nested = ActionRuntimeLive.pipe(
  Layer.provide(ApiKeyServiceLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie)),
);
