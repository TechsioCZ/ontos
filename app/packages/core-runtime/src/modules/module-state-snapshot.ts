import type { TenantModuleState } from './tenant-module-state-service.ts';

export interface ModuleStateSnapshot {
  readonly entrypointKeys: readonly string[];
  readonly moduleKeys: readonly string[];
  readonly tenantId: string;
}

interface ModuleStateSnapshotData {
  readonly declaredEntrypoints: ReadonlySet<string>;
  readonly evaluatedEntrypoints: Set<string>;
  readonly states: ReadonlyMap<string, TenantModuleState>;
}

export class ModuleStateSnapshotValue implements ModuleStateSnapshot {
  readonly #data: ModuleStateSnapshotData;
  readonly entrypointKeys: readonly string[];
  readonly moduleKeys: readonly string[];
  readonly tenantId: string;

  constructor(
    tenantId: string,
    entrypointKeys: readonly string[],
    moduleKeys: readonly string[],
    data: ModuleStateSnapshotData
  ) {
    this.#data = data;
    this.entrypointKeys = entrypointKeys;
    this.moduleKeys = moduleKeys;
    this.tenantId = tenantId;
    Object.freeze(this);
  }

  static dataOf(
    snapshot: ModuleStateSnapshot
  ): ModuleStateSnapshotData | undefined {
    return #data in snapshot ? snapshot.#data : undefined;
  }
}
