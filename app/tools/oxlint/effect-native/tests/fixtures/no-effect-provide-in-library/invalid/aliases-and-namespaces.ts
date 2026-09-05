// expect-count: 4
// Alias imports, submodule namespace imports, optional chaining and computed members all count.
import { Effect as Fx } from "effect";
import * as EffectNs from "effect/Effect";

declare const RequirementsLayer: never;
declare const program: Fx.Effect<unknown, never, never>;

export const aliased = program.pipe(Fx.provide(RequirementsLayer));

export const namespaced = EffectNs.provide(program, RequirementsLayer);

export const optional = program.pipe(Fx?.provide(RequirementsLayer));

export const computed = program.pipe(Fx["provide"](RequirementsLayer));
