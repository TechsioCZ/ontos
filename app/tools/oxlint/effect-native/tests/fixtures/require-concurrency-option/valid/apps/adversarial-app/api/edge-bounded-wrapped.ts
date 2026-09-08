import { Effect } from 'effect';

declare const ids: readonly string[];
declare const load: (id: string) => Effect.Effect<string>;
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;
declare const limit: number;

// The bound survives every wrapper and key spelling the parser can put around it.
export const asConst = Effect.all([left, right], { concurrency: 4 } as const);
export const quotedKey = Effect.forEach(ids, load, { 'concurrency': 4 });
export const computedKey = Effect.forEach(ids, load, { ['concurrency']: 4 });
export const shorthand = Effect.all([left, right], { concurrency: limit });
export const satisfied = Effect.all([left, right], { concurrency: 2 } satisfies { readonly concurrency: number });
