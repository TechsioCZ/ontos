import { Effect, pipe, Function as F } from "effect";
import { runPromise as run } from "effect/Effect";
const runner = Effect.runPromise;
export const adapter = (request: Request) => F.pipe(Effect.gen(function* () { return request.url; }), runner);
export const directAdapter = (request: Request) => pipe(Effect.gen(function* () { return request.url; }), run);
export const predicate = (input: string) => Effect.gen(function* () { return input; }).pipe(Effect.isEffect);
// An arbitrary pipeline operator can change the return kind. No type checker means no claim
// that this returns Effect, regardless of the initial generator.
const describe = (effect: unknown): string => String(effect);
export const description = (input: string) => pipe(Effect.gen(function* () { return input; }), describe);
