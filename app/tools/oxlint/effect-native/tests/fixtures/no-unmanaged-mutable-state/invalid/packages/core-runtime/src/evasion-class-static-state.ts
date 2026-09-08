// expect-count: 2
// Evasion: the same module-level memoization moved onto `static` class members. Its lifetime is
// still the module registry, not a Layer/Scope (audit B4 "module-level mutable memoization").
export interface ModuleRecord {
	readonly key: string;
}

export class ModuleRegistry {
	static installedCount = 0;
	static readonly cache = new Map<string, ModuleRecord>();

	static register(record: ModuleRecord): void {
		ModuleRegistry.cache.set(record.key, record);
		ModuleRegistry.installedCount += 1;
	}

	static lookup(key: string): ModuleRecord | undefined {
		return ModuleRegistry.cache.get(key);
	}
}
