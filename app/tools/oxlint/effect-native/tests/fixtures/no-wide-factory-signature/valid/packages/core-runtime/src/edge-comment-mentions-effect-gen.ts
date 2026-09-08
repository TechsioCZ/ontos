import { Effect } from 'effect';

/**
 * A pure value bag. The body is an object literal — the only occurrence of `Effect.gen` in it is a
 * TODO comment about a future refactor, which must not turn a data constructor into a B4 report.
 */
export const createPoolConfig = (options: DatabasePoolOptions) => ({
  // TODO: once the driver is a Context service, acquire it in Effect.gen and yield* the clock.
  idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
  max: options.max ?? 10,
  min: options.min ?? 1,
});

export const PoolConfigLive = Effect.succeed(createPoolConfig({}));
