// expect-count: 2
import { Effect } from 'effect';

declare const ids: readonly string[];
declare const load: (id: string) => Effect.Effect<string>;
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;

export const each = Effect.forEach(ids, load);
export const both = Effect.all([left, right]);
