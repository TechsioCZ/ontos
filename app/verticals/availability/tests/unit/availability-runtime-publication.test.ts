import { getVerticalRuntimeEntrypoints } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeAvailabilityApiRuntime } from '../../api/index.ts';
import { getAvailabilityReadiness } from '@app/availability/api/client';
import { availabilityApi, availabilityReadinessSchema } from '../../shared/api.ts';
import { CurrentAvailabilityApi } from '../../shared/apis/current-availability.ts';
import { availabilityManifest } from '../../vertical.manifest.ts';
import { availabilityRegistration } from '../../vertical.registration.ts';

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

it('preserves the typed contract without registering an executable or discoverable contribution', () => {
  expect(Object.keys(CurrentAvailabilityApi.groups)).not.toHaveLength(0);
  expect(Object.keys(availabilityApi.groups)).toEqual(['foundation']);
  expect(availabilityManifest.publicSurface.api).toEqual({});
  expect(getVerticalRuntimeEntrypoints(availabilityRegistration).api).toEqual({});
  expect(availabilityManifest.publicSurface.components).toEqual({});
  expect(availabilityManifest.publicSurface.search).toEqual([]);
  expect(availabilityManifest.publicSurface.shellContributions.pages).toEqual([]);
  expect(Effect.isEffect(getAvailabilityReadiness)).toBe(true);
});
