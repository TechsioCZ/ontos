// expect-count: 3
// `as`, `satisfies` and optional-call wrappers around the same run site.
import { Effect } from "effect";

type Runner = (effect: Effect.Effect<number>) => Promise<number>;

declare const program: Effect.Effect<number>;

export const viaAs = Effect.sync(() => void (Effect.runPromise as Runner)(program));

export const viaSatisfies = Effect.sync(() => void (Effect.runPromise satisfies Runner)(program));

export const viaOptionalCall = Effect.sync(() => void Effect?.runPromise?.(program));
