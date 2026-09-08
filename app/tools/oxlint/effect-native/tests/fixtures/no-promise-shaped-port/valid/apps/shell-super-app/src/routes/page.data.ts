/** Framework router entrypoints (allowNames): Modern.js calls these and consumes a Promise. */
import { Effect } from "effect";

const runtime = { runPromise: <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect) };

export const loader = async () => await runtime.runPromise(Effect.succeed({ ok: true }));

export const action = async () => await runtime.runPromise(Effect.void);
