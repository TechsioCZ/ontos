// A policy at the end of the pipeline bounds a bridge inside a combinator callback of that same
// pipeline exactly as it bounds one inside an `Effect.gen` body (which the rule already crosses).
// The first shape is literally audit B1's prescribed remedy — bounded `Effect.forEach` plus an
// explicit timeout — so the rule can never go green on a fixed B1 while it still reports here.
import { Effect } from 'effect';

declare const db: { read: (id: string) => Promise<string> };
declare const ids: readonly string[];

export const bounded = Effect.forEach(ids, (id) => Effect.tryPromise(() => db.read(id)), {
  concurrency: 4,
}).pipe(Effect.timeout('5 seconds'));

// `Effect.fn`'s trailing pipeline arguments are the documented equivalent of a trailing `.pipe`,
// and the rule's `crossEffectGen` already claims `Effect.fn` support.
export const traced = Effect.fn('load')(function* (id: string) {
  return yield* Effect.tryPromise(() => db.read(id));
}, Effect.timeout('5 seconds'));
