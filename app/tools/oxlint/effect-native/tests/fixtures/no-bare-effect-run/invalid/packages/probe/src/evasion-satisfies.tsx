// expect-count: 3
import { Effect } from 'effect';

declare const program: Effect.Effect<number>;

const run = Effect.runSync satisfies (effect: Effect.Effect<number>) => number;

const handlers = [Effect.runPromise as (effect: Effect.Effect<number>) => Promise<number>];

export function View(): unknown {
	return <div onClick={() => void Effect.runFork(program)}>{`${run(program)}:${handlers.length}`}</div>;
}
