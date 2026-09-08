// expect-count: 7
// B4: module-level memoization and accumulators that no Layer, Scope or ManagedRuntime owns.
export interface ModuleRecord {
	readonly key: string;
}

let installedCount = 0;
var legacyBootstrapped = false;
export let activeTenantId: string | undefined;

const moduleCache = new Map<string, ModuleRecord>();
const pendingKeys = new Set<string>();
const auditTrail: string[] = [];
const statusByKey: Record<string, string> = {};

export const register = (record: ModuleRecord, tenantId: string): void => {
	moduleCache.set(record.key, record);
	pendingKeys.add(record.key);
	auditTrail.push(record.key);
	statusByKey[record.key] = "installed";
	installedCount += 1;
	legacyBootstrapped = true;
	activeTenantId = tenantId;
};

export const lookup = (key: string): ModuleRecord | undefined => moduleCache.get(key);

export const summary = (): string =>
	`${String(installedCount)}/${String(legacyBootstrapped)}/${auditTrail.join(",")}`;
