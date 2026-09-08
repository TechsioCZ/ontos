// `tools/**` is outside `include` and inside the default `ignore`.
import { Effect } from 'effect';

declare const alpha: { readonly read: () => Effect.Effect<string> };
declare const beta: { readonly read: () => Effect.Effect<string> };

export const program = Effect.gen(function* () {
  const first = yield* alpha.read();
  const second = yield* beta.read();
  return { first, second };
});
