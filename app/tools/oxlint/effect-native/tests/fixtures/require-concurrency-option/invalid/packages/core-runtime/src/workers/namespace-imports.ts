// expect-count: 3
import * as EFX from 'effect';
import * as EffectNs from 'effect/Effect';
import { forEach as eachEffect } from 'effect/Effect';

declare const items: readonly string[];
declare const run: (value: string) => EffectNs.Effect<number>;
declare const left: EffectNs.Effect<number>;
declare const right: EffectNs.Effect<number>;

// `import * as EffectNs from "effect/Effect"` binds the whole submodule.
export const both = EffectNs.all([left, right]);

// `import * as EFX from "effect"` binds the root namespace: `EFX.Effect.forEach`.
export const each = EFX.Effect.forEach(items, run);

// A direct member import is the same call under another name.
export const alsoEach = eachEffect(items, run);
