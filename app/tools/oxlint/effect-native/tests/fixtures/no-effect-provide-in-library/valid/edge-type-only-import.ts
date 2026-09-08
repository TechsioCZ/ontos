// A type-only import registers a binding but can never produce a runtime member expression.
import type { Effect } from "effect";

export type Program = Effect.Effect<string, never, never>;
export declare const provideNothing: Effect.Effect<void, never, never>;
