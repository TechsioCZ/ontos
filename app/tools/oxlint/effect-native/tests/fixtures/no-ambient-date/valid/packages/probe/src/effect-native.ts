/** The Effect-native temporal model: DateTime for instants, Duration for intervals, Schema for encoding. */
import { DateTime, Duration, Effect, Schema } from "effect";

export const lease = Duration.minutes(5);
export const requestTimeout = Duration.seconds(30);
export const pollInterval = Duration.hours(1);

export const stampedAt = Effect.gen(function* () {
	const now = yield* DateTime.now;
	const expiresAt = DateTime.add(now, { minutes: 5 });
	return { epoch: DateTime.toEpochMillis(now), expiresAt, now };
});

export const RowSchema = Schema.Struct({
	createdAt: Schema.DateTimeUtc,
	updatedAt: Schema.DateTimeUtcFromDate,
});
