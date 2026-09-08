// expect-count: 3
// updateService deliberately remains unreported: it retains the service requirement.
// Evasion: import the combinator itself instead of the namespace. Sibling rules in this plugin
// (no-bare-effect-run, no-layer-or-die-outside-root, require-timeout-on-external-effect, ...) all
// treat `import { member } from "effect/Effect"` as an equivalent reference and report it.
import { provide, provideService as supplyService } from "effect/Effect";
import { provideReferences, updateService } from "effect/Effect";

declare const RequirementsLayer: never;
declare const Clock: never;
declare const clock: never;
declare const requestId: string;
declare const program: { readonly pipe: (step: unknown) => unknown };

export const a = program.pipe(provide(RequirementsLayer));

export const b = program.pipe(supplyService(Clock, clock));

export const c = program.pipe(provideReferences({ requestId }));

export const d = program.pipe(updateService(Clock, (value: never) => value));
