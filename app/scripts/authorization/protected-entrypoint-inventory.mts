import { createHash } from 'node:crypto';

export const PROTECTED_ENTRYPOINT_INVENTORY_SCHEMA_VERSION = 1 as const;

export type InventoryAuthorization =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated_principal' }
  | { readonly kind: 'context_permission'; readonly permission: string }
  | {
      readonly kind: 'action_execution';
      readonly provisioning: 'explicit' | 'tenant_membership_default';
    }
  | { readonly kind: 'owner_local_background' }
  | { readonly credential: 'api_key' | 'session'; readonly kind: 'capability_issuance' };

export type ProtectedEntrypointSurface = 'action' | 'capability_issuance' | 'route' | 'worker';

export interface ProtectedEntrypointInventoryEntry {
  readonly authorization: InventoryAuthorization;
  readonly deployment: string;
  readonly entrypointKey: string;
  readonly owner: string;
  readonly surface: ProtectedEntrypointSurface;
}

export interface ProtectedEntrypointInventory {
  readonly entries: readonly ProtectedEntrypointInventoryEntry[];
  readonly inventoryHash: string;
  readonly schemaVersion: typeof PROTECTED_ENTRYPOINT_INVENTORY_SCHEMA_VERSION;
  readonly sourceRevision: string;
}

const stableValue = (value: string, field: string): string => {
  if (!/^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/u.test(value)) {
    throw new TypeError(`${field} must be a stable, non-sensitive identifier`);
  }
  return value;
};

const normalizeAuthorization = (raw: InventoryAuthorization): InventoryAuthorization => {
  const authorization = raw as unknown as Record<string, unknown>;
  const keys = Object.keys(authorization).toSorted();
  const kind = authorization['kind'];
  if (
    (kind === 'public' ||
      kind === 'authenticated_principal' ||
      kind === 'owner_local_background') &&
    keys.length === 1
  ) {
    return { kind };
  }
  if (
    kind === 'context_permission' &&
    keys.join('\0') === 'kind\0permission' &&
    typeof authorization['permission'] === 'string' &&
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(authorization['permission'])
  ) {
    return { kind, permission: authorization['permission'] };
  }
  if (
    kind === 'action_execution' &&
    keys.join('\0') === 'kind\0provisioning' &&
    (authorization['provisioning'] === 'explicit' ||
      authorization['provisioning'] === 'tenant_membership_default')
  ) {
    return { kind, provisioning: authorization['provisioning'] };
  }
  if (
    kind === 'capability_issuance' &&
    keys.join('\0') === 'credential\0kind' &&
    (authorization['credential'] === 'api_key' || authorization['credential'] === 'session')
  ) {
    return { credential: authorization['credential'], kind };
  }
  throw new TypeError('inventory authorization classification is invalid or contains excess data');
};

export const normalizeProtectedEntrypointInventory = (
  entries: readonly ProtectedEntrypointInventoryEntry[],
): readonly ProtectedEntrypointInventoryEntry[] => {
  const normalized = entries.map((entry) => ({
    authorization: normalizeAuthorization(entry.authorization),
    deployment: stableValue(entry.deployment, 'deployment'),
    entrypointKey: stableValue(entry.entrypointKey, 'entrypointKey'),
    owner: stableValue(entry.owner, 'owner'),
    surface: entry.surface,
  }));
  const seen = new Set<string>();
  for (const entry of normalized) {
    if (!['action', 'capability_issuance', 'route', 'worker'].includes(entry.surface)) {
      throw new TypeError(`unsupported inventory surface: ${String(entry.surface)}`);
    }
    if (seen.has(entry.entrypointKey)) {
      throw new TypeError(`duplicate protected entrypoint: ${entry.entrypointKey}`);
    }
    seen.add(entry.entrypointKey);
  }
  return normalized.toSorted(
    (left, right) =>
      left.surface.localeCompare(right.surface) ||
      left.entrypointKey.localeCompare(right.entrypointKey),
  );
};

export const hashProtectedEntrypointInventory = (
  entries: readonly ProtectedEntrypointInventoryEntry[],
): string =>
  createHash('sha256')
    .update(`${JSON.stringify(entries)}\n`)
    .digest('hex');

export const makeProtectedEntrypointInventory = (
  sourceRevision: string,
  entries: readonly ProtectedEntrypointInventoryEntry[],
): ProtectedEntrypointInventory => {
  if (!/^[a-zA-Z0-9._-]{1,100}$/u.test(sourceRevision)) {
    throw new TypeError('sourceRevision must be a stable revision identifier');
  }
  const normalized = normalizeProtectedEntrypointInventory(entries);
  return {
    entries: normalized,
    inventoryHash: hashProtectedEntrypointInventory(normalized),
    schemaVersion: PROTECTED_ENTRYPOINT_INVENTORY_SCHEMA_VERSION,
    sourceRevision,
  };
};

export const serializeProtectedEntrypointInventory = (
  inventory: ProtectedEntrypointInventory,
): string => `${JSON.stringify(inventory, undefined, 2)}\n`;
