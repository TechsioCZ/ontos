import { Duration, Effect, Schedule } from 'effect';

/** B1 target shape: declarative interval, typed timeout, interruption-aware scope. */
export const pollOutbox = (tick: Effect.Effect<void>, intervalMillis: number) =>
	tick.pipe(
		Effect.timeout(Duration.seconds(30)),
		Effect.repeat(Schedule.spaced(Duration.millis(intervalMillis))),
		Effect.retry(Schedule.exponential(Duration.millis(50))),
	);
