// expect-count: 3
import { Effect } from 'effect';

declare const stored: {
  readonly read: () => Effect.Effect<string>;
  readonly randomBytes: () => Effect.Effect<string>;
  readonly uuidV4: () => Effect.Effect<string>;
  readonly uuidV7: () => Effect.Effect<string>;
};

export const program = Effect.gen(function* () {
  const first = yield* stored.read();
  const bytes = yield* stored.randomBytes();
  const fourth = yield* stored.uuidV4();
  const seventh = yield* stored.uuidV7();
  return { bytes, first, fourth, seventh };
});
