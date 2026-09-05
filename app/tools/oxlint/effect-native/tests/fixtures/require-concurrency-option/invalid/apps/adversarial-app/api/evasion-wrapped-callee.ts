// expect-count: 6
import { Effect, pipe } from 'effect';

declare const ids: readonly string[];
declare const load: (id: string) => Effect.Effect<string>;
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;

// Parenthesised optional-chain callee.
export const a1 = (Effect?.forEach)(ids, load);

// Non-null assertion on the callee.
export const a2 = Effect.all!([left, right]);

// `as` on the callee.
export const a3 = (Effect.all as typeof Effect.all)([left, right]);

// `satisfies` on the callee.
export const a4 = (Effect.forEach satisfies typeof Effect.forEach)(ids, load);

// Optional call on an optional member.
export const a5 = Effect?.forEach?.(ids, load);

// Point-free operator handed to `pipe` with no options at all.
export const a6 = pipe(ids, Effect.forEach(load));
