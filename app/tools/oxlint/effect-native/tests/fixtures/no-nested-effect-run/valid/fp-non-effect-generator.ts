// FALSE POSITIVE regression fixture.
//
// `isInsideEffectOwnedCode` returns true for *any* delegating `yield*` on the walk to Program, even
// in a generator that has nothing to do with Effect. Passing `Effect.runPromise` as a plain function
// value through such a generator is unrelated code, not root-fiber re-entry inside Effect-owned code.
import { Effect } from "effect";

declare const program: Effect.Effect<void>;
declare function call<T>(fn: T, arg: unknown): Generator<unknown, unknown>;

export function* saga(): Generator<unknown, unknown> {
  return yield* call(Effect.runPromise, program);
}
