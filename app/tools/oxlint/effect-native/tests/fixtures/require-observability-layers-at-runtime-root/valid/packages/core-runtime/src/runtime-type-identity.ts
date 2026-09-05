import type * as Foreign from "unrelated-runtime";
import type { EffectBffRuntime as Runtime } from "@modern-js/plugin-bff/effect-edge";
import { runPromise } from "effect/Effect";
// Neither a lookalike qualified type nor a locally shadowed imported type is a runtime factory.
export const foreignFactory = (): Foreign.EffectBffRuntime<unknown> => ({} as never);
export function identity<Runtime>(value: Runtime): Runtime { return value; }
export type Runner = typeof runPromise;
