// expect-count: 3
import { Effect } from 'effect';
declare const values: readonly number[];
declare const read: (n: number) => Effect.Effect<number>;
export const count = Effect.gen(function* () {
  let total = 0;
  let { count } = { count: 0 };
  for (const n of values) {
    { let total = 10; total++; }
    total++;
    count++;
    yield* read(n);
  }
  return [total, count];
});
