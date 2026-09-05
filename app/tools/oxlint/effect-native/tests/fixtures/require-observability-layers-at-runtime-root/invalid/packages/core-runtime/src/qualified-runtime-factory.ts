// expect-count: 3
import type * as Framework from "@modern-js/plugin-bff/effect-edge";
// A value-level factory returning the actual framework type remains a root candidate.
export const build = (): Framework.EffectBffRuntime<unknown> => ({} as never);
