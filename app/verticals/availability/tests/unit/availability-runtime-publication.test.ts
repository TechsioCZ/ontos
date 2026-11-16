import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeAvailabilityApiRuntime } from '../../api/index.ts';
import { availabilityReadinessSchema } from '../../shared/api.ts';

it.effect('production composition serves foundation readiness without publishing the unavailable business read', () =>
  Effect.gen(function* availabilityRuntimePublication() {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => makeAvailabilityApiRuntime().createHandler()),
      (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
    );
    const response = yield* Effect.promise(() =>
      runtime.handler(new Request('http://localhost/availability/readiness')),
    );
    expect(response.status).toBe(200);
    const readiness = yield* Schema.decodeUnknownEffect(availabilityReadinessSchema)(
      yield* Effect.promise(() => response.json()),
    );
    expect(readiness.status).toBe('ready');
    expect(readiness.marker.appId).toBe('availability');
    const removedRead = yield* Effect.promise(() =>
      runtime.handler(
        new Request('http://localhost/reads/current-availability', {
          body: '{}',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      ),
    );
    expect(removedRead.status).toBe(404);
  }),
);
