// expect-count: 2
// Point-free / by-reference use of the bridge: the same unbounded Promise boundary, no call node
// whose callee is `Effect.promise`.
import { Effect, pipe } from 'effect';

declare const thunk: () => Promise<string>;
declare const thunks: readonly (() => Promise<string>)[];

// 1 — `pipe(x, Effect.promise)` is `Effect.promise(x)` with no policy anywhere in the chain.
export const bridged = pipe(thunk, Effect.promise);

// 2 — the bridge handed to `map` as a function reference: N unbounded effects, run concurrently.
export const fanOut = Effect.all(thunks.map(Effect.promise));
