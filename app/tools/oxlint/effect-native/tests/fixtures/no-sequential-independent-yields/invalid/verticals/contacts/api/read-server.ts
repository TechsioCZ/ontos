// expect-count: 1
// B1: readSettings is an opaque Effect value, not a provable remote call.
// Aliased `Effect` import, `Effect.fn` wrapper, `x.pipe(...)` and `pipe(x, ...)` subjects.
import { Effect as Fx, pipe } from "effect";

declare const repository: { readonly findCustomer: (id: string) => Fx.Effect<string> };
declare const ares: { readonly lookup: (ico: string) => Fx.Effect<string> };
declare const audit: { readonly readSettings: Fx.Effect<string> };

export const load = Fx.fn('load')(function* (id: string, ico: string) {
  const customer = yield* repository.findCustomer(id).pipe(Fx.withSpan('find-customer'));
  const subject = yield* pipe(ares.lookup(ico), Fx.timeout('2 seconds'));
  const settings = yield* audit.readSettings;
  return { customer, settings, subject };
});
