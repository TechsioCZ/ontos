import { Effect } from 'effect';
declare const api: { read(): Effect.Effect<string>; authenticate(): Effect.Effect<void>; authorize(): Effect.Effect<void>; reconcile(): Effect.Effect<void> };
// B1 explicitly preserves semantic ordering: guards and writes cannot be treated as independent reads.
export const guards = Effect.gen(function* () {
  const a = yield* api.authenticate();
  const b = yield* api.read();
  const c = yield* api.authorize();
  const d = yield* api.read();
  const e = yield* api.reconcile();
  const f = yield* api.read();
  return [a, b, c, d, e, f];
});
export function shadow(Effect: { gen: (body: () => Generator) => unknown }) {
  return Effect.gen(function* () {
    const a = yield* api.read();
    const b = yield* api.read();
    return [a, b];
  });
}
