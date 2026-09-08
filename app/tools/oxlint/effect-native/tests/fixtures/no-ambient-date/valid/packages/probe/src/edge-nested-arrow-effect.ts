/** Nested arrows / point-free pipes over the Effect temporal API. */
import { DateTime, Duration, Effect } from "effect";

export const expiry = Effect.gen(function* () {
	const now = yield* DateTime.now;
	return DateTime.addDuration(now, Duration.minutes(5));
});

export const tomorrow = Effect.map(DateTime.now, (now) => DateTime.add(now, { days: 1 }));
