import { Effect } from 'effect';
import { runSync } from 'effect/Effect';

declare const inner: Effect.Effect<number>;
declare const runtime: { runSync: <A>(effect: Effect.Effect<A>) => A };

/** The imported entry point is only used inside Effect-owned code. */
export const program = Effect.gen(function* () {
	return runSync(inner);
});

/** A port whose member merely shares the name is not a run site. */
export interface Runner {
	runSync: <A>(effect: Effect.Effect<A>) => A;
}

export class HostRunner implements Runner {
	readonly runSync = <A>(effect: Effect.Effect<A>): A => runtime.runSync(effect);
}

export class OtherRunner {
	runSync<A>(effect: Effect.Effect<A>): A {
		return runtime.runSync(effect);
	}
}
