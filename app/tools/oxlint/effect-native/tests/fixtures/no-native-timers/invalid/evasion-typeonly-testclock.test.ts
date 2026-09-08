// expect-count: 2
import { Effect } from 'effect';
import type { TestClock } from 'effect/testing';

/** A type-only TestClock import proves nothing: this file still sleeps on the real Clock. */
export const program = (clock: TestClock.TestClock) =>
	Effect.gen(function* () {
		yield* Effect.sleep('50 millis');
		yield* Effect.timeout(Effect.void, '1 second');
		return clock;
	});
