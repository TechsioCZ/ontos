// expect-count: 3
import { Effect as E } from 'effect';
import * as EffectModule from 'effect/Effect';

declare const program: E.Effect<number>;

export function Panel(): unknown {
	const first = E.runSync(program);
	const second = EffectModule.runSync(program);
	const forked = E?.runFork(program);
	return <div>{`${first}:${second}:${String(forked !== undefined)}`}</div>;
}
