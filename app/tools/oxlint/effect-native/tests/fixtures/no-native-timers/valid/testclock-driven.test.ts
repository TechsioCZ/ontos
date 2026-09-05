import { Effect, Schedule } from 'effect';
import { TestClock } from 'effect/testing';

export const program = Effect.gen(function* () {
	yield* Effect.sleep('1 second');
	yield* TestClock.adjust('1 second');
	yield* Effect.repeat(Effect.void, Schedule.recurs(3));
}).pipe(Effect.provide(TestClock.layer()));
