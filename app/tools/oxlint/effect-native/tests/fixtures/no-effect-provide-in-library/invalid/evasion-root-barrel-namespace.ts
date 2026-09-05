// expect-count: 3
// Evasion: the root barrel namespace. `collectEffectBindings` only registers `import * as X from
// "effect/Sub"`, so `EffectNs.Effect.provide` walks straight past this rule. Sibling rules
// (no-runtime-construction-outside-root, no-layer-or-die-outside-root, no-sequential-independent-yields)
// keep a separate barrel map for exactly this shape.
import * as EffectNs from "effect";
import * as E from "effect";

declare const RequirementsLayer: never;
declare const Clock: never;
declare const clock: never;
declare const program: EffectNs.Effect.Effect<string, never, never>;

export const a = EffectNs.Effect.provide(program, RequirementsLayer);

export const b = program.pipe(EffectNs.Effect.provideService(Clock, clock));

export const c = program.pipe(E.Effect.provideReferences({ requestId: "r" }));
