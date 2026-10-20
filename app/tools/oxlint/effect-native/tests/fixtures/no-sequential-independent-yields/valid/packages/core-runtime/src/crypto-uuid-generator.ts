// Effect 4.0.5 made Crypto's UUID generators zero-argument methods. They are local values with no
// latency to overlap, so they keep the verdict of the former `yield* crypto.randomUUIDv4` accessor.
import { Effect } from 'effect';

declare const crypto: {
  readonly randomUUIDv4: () => Effect.Effect<string>;
  readonly randomUUIDv7: () => Effect.Effect<string>;
};
declare const store: { readonly digest: (value: string) => Effect.Effect<string> };

export const register = (token: string) =>
  Effect.gen(function* () {
    const digest = yield* store.digest(token);
    const reference = yield* crypto.randomUUIDv4().pipe(Effect.map((value) => value.toUpperCase()));
    const sortable = yield* crypto.randomUUIDv7();
    return { digest, reference, sortable };
  });
