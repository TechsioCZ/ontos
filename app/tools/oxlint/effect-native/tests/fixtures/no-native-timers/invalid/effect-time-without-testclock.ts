// expect-count: 6
import { Clock, DateTime, Effect, Schedule } from 'effect';

export const program = Effect.gen(function* () {
	yield* Effect.sleep('50 millis');
	yield* Effect.timeout(Effect.void, '1 second');
	yield* Effect.repeat(Effect.void, Schedule.spaced('10 millis'));
	const now = yield* Clock.currentTimeMillis;
	const stamp = yield* DateTime.now;
	return { now, stamp };
});
