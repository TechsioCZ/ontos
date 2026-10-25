import { FetchHttpClient } from 'effect/unstable/http';

import { Layer, Logger, ManagedRuntime, Random, References, Tracer } from 'effect';

const browserTracer = Tracer.make({
  span: (options) => new Tracer.NativeSpan(options),
});

// Idempotency keys use Effect's injected Random, backed by browser cryptographic entropy rather than Math.random.
const browserRandom: Random.Random = {
  nextDoubleUnsafe() {
    const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
    return ((high % 2 ** 21) * 2 ** 32 + low) / 2 ** 53;
  },
  nextIntUnsafe() {
    const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
    const magnitude = (high % 2 ** 21) * 2 ** 32 + low;
    return high < 2 ** 31 ? magnitude : -magnitude;
  },
};

export const browserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.RequestInit, { credentials: 'same-origin' }),
    Layer.succeed(Random.Random, browserRandom),
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, browserTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);
