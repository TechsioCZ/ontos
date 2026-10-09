import { Effect, Predicate, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeLiveOperationFixture } from '../../src/testing/live-operations.ts';

it.effect(
  'live fixture rejects missing and malformed release pins before reading configuration or opening services',
  () =>
    Effect.gen(function* rejectInvalidFixtureRelease() {
      for (const compositionRevision of ['', 'latest', 'a'.repeat(63), 'A'.repeat(64)]) {
        const failure = yield* Effect.flip(
          makeLiveOperationFixture({
            authenticationNamespaceId: 'fixture-release-unit',
            compositionRevision,
            runtimeConnectionString: Redacted.make('postgresql://unit:unit@127.0.0.1/unit'),
          }),
        );
        expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
        expect(failure.reason).toBe('Invalid live operation fixture configuration');
      }
    }),
);
