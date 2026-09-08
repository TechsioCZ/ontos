// expect-count: 1
// Pathological parse shape: a decorator argument on an `accessor` field.
import { Effect } from "effect";

declare const RequirementsLayer: never;
declare const program: Effect.Effect<string, never, never>;
declare function bind(value: unknown): (target: unknown, context: unknown) => void;

export class Handler {
  @bind(Effect.provide(program, RequirementsLayer))
  accessor prepared: unknown = undefined;
}
