// expect-count: 4
import { Effect } from 'effect';

declare const load: (id: string) => Effect.Effect<string>;

export const curried = (id: string) => () => async (): Promise<string> => await Effect.runPromise(load(id));

export const withDefault = (run: (effect: Effect.Effect<string>) => string = Effect.runSync): string =>
	run(load('x'));

export const conditional = (id: string): string =>
	typeof Effect?.runSync === 'function' ? Effect.runSync(load(id)) : id;
