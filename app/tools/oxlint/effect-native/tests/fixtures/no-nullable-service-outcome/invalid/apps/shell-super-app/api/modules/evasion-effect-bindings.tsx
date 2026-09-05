// expect-count: 5
import { Effect as Eff } from "effect";
import * as Barrel from "effect";
import * as EffectModule from "effect/Effect";
import type { Effect as EffectType } from "effect/Effect";

export interface TenantModuleState {
	readonly moduleId: string;
}

export class StateError extends Error {}

/** Every real `effect` binding shape must resolve to the same nullable outcome. */
export interface ShellResourcePorts {
	readonly aliased: () => Eff.Effect<TenantModuleState | undefined, StateError>;
	readonly barrel: () => Barrel.Effect.Effect<TenantModuleState | null, StateError>;
	readonly submodule: () => EffectModule.Effect<TenantModuleState | undefined, StateError>;
	readonly bare: () => EffectType<TenantModuleState | null, StateError>;
	readonly likely: () => PromiseLike<TenantModuleState | undefined>;
}

export function ShellPanel() {
	return <section className="shell-panel">ok</section>;
}
