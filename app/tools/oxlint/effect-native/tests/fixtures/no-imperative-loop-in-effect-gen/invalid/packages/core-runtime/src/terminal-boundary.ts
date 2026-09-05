// expect-count: 3
import { Effect } from 'effect';
declare const values: readonly number[];
declare const read: (n: number) => Effect.Effect<number>;
// A terminal return does not exempt another yield that actually sequences work.
export const mixed = Effect.gen(function* () {
  for (const n of values) {
    const value = yield* read(n);
    if (value === 0) return yield* read(n);
  }
});
// Finally can override return, so this is not the pure-search exception.
export const overridden = Effect.gen(function* () {
  for (const n of values) {
    try { return yield* read(n); } finally { continue; }
  }
});
// A catch can resume the loop after a thrown yield result.
export const caught = Effect.gen(function* () {
  for (const n of values) {
    try { throw yield* read(n); } catch { continue; }
  }
});
