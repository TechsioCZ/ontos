import { Effect } from 'effect';
import * as Testing from 'effect/testing';

export const Timer = () => <span>{String(Effect.sleep)}</span>;

export const program = Effect.gen(function* () {
	yield* Effect.sleep('10 millis');
	yield* Testing.TestClock.adjust('10 millis');
});
