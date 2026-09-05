// expect-count: 6
// Every way the `catch` handler can be spelled on the options object.
import { Effect } from 'effect';

class Unavailable {}
declare const write: () => Promise<void>;
declare const base: { readonly try: () => Promise<void> };

export const shorthandMethod = Effect.tryPromise({
  try: write,
  catch() {
    return new Unavailable();
  },
});
export const asyncArrow = Effect.tryPromise({ try: write, catch: async () => new Unavailable() });
export const stringKey = Effect.try({ try: () => 1, 'catch': () => new Unavailable() });
export const spreadOptions = Effect.tryPromise({ ...base, catch: () => new Unavailable() });
export const dataFirstOptions = Effect.tryMap(Effect.succeed(1), {
  try: (value: number) => value,
  catch: () => new Unavailable(),
});
export const unusedNamed = Effect.tryPromise({ try: write, catch: (_cause: unknown) => new Unavailable() });
