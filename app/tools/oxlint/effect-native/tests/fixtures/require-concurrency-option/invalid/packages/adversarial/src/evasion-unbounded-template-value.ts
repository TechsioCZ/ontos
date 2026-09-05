// expect-count: 2
import { Effect } from 'effect';

declare const ids: readonly string[];
declare const load: (id: string) => Effect.Effect<string>;
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;

// `concurrency: \`unbounded\`` is the same unbounded fan-out as the quoted spelling.
export const flooded = Effect.all([left, right], { concurrency: `unbounded` });
export const inherited = Effect.forEach(ids, load, { concurrency: `inherit` });
