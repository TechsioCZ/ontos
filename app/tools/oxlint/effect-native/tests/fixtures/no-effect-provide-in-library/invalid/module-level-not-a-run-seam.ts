// expect-count: 2
// Module top level, but nothing runs here: this is an exported library program with an erased R.
import { Effect } from "effect";

declare const RequirementsLayer: never;
declare const program: Effect.Effect<string, never, never>;

export const preProvided = program.pipe(Effect.provide(RequirementsLayer));

const providePartial = Effect.provide;
export const alsoPreProvided = providePartial(program, RequirementsLayer);
