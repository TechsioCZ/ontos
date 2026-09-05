/** A locally declared type named `Effect` is not `effect`'s `Effect`. */
interface Effect<A, E> {
	readonly _A: A;
	readonly _E: E;
}

export interface TenantModuleState {
	readonly moduleId: string;
}

export interface LocalPorts {
	readonly load: () => Effect<TenantModuleState | undefined, never>;
	readonly claim: () => Effect<TenantModuleState | null, never>;
}
