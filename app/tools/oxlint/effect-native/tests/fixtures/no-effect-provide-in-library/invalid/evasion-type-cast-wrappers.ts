// expect-count: 4
// `as` / `satisfies` / instantiation expressions and optional-chained computed access must not hide
// the reference.
import { Effect } from "effect";

declare const RequirementsLayer: never;
declare const program: Effect.Effect<string, never, never>;
type Provide = (layer: never) => (self: unknown) => unknown;

export const a = (Effect.provide as unknown as Provide)(RequirementsLayer)(program);

export const b = (Effect.provide satisfies Provide)(RequirementsLayer)(program);

export const c = (Effect?.["provide"])(program, RequirementsLayer);

export const d = Effect.provide<never>;
