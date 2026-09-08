// `typeof Effect.provide` in a type position is a type reference, not a runtime provide.
import { Effect } from "effect";

declare const program: Effect.Effect<string, never, never>;

export type ProvideParameters = Parameters<typeof Effect.provide>;
export type ProvideService = typeof Effect.provideService;
export const passthrough = program;
