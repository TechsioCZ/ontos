// expect-count: 4
import { Effect } from "effect";

export interface TenantModuleState {
	readonly moduleId: string;
}

export class ShellProviderUnavailableError extends Error {}

export type MaybeTenantModuleState = TenantModuleState | undefined;
export type MaybeTenantModuleStateAlias = MaybeTenantModuleState;

export interface ShellResourceReader {
	(tenantId: string): Promise<MaybeTenantModuleState>;
	readonly load: (
		tenantId: string,
	) => Effect.Effect<MaybeTenantModuleStateAlias, ShellProviderUnavailableError>;
}

export declare function readTenantModuleState(tenantId: string): Promise<TenantModuleState | undefined>;

export class ShellResources {
	async loadState(tenantId: string): Promise<TenantModuleState | null> {
		void tenantId;
		return null;
	}
}
