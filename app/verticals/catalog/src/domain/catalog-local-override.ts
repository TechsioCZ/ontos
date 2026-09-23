import { Schema } from 'effect';

import type { CatalogFactScope, CatalogLocalOverride } from './catalog-source-resolution.ts';

/** Activate, change, and release are distinct operations with distinct #477 Permissions. */
const CatalogLocalOverrideOperationSchema = Schema.Literals(['ACTIVATE', 'CHANGE', 'RELEASE']);
export type CatalogLocalOverrideOperation = typeof CatalogLocalOverrideOperationSchema.Type;

export const catalogLocalOverridePermission = {
  ACTIVATE: 'commerce.catalog.activate-local-override',
  CHANGE: 'commerce.catalog.change-local-override',
  RELEASE: 'commerce.catalog.release-local-override',
} as const satisfies Record<CatalogLocalOverrideOperation, string>;

const FOREIGN_FACT_FAMILIES = ['inventory', 'legal-entity', 'party', 'permission', 'price'] as const;
const FACT_FAMILY_SEPARATORS = ['.', '/', ':', '-'] as const;

/**
 * Price, Inventory, Party/Legal Entity identity, and Permission are owned by other applications.
 * Local Override is an explicit Catalog decision about one Catalog-owned fact, so it must never
 * hold those families even when a caller mislabels the scope.
 */
export const isCatalogLocalOverrideFactKeyAllowed = (factKey: string): boolean => {
  const normalized = factKey.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return !FOREIGN_FACT_FAMILIES.some(
    (family) =>
      normalized === family ||
      FACT_FAMILY_SEPARATORS.some((separator) => normalized.startsWith(`${family}${separator}`)),
  );
};

const sameScope = (left: CatalogFactScope, right: CatalogFactScope): boolean =>
  left.tenantId === right.tenantId &&
  left.targetKind === right.targetKind &&
  left.targetId === right.targetId &&
  left.factKey === right.factKey;

/**
 * A single active override revision may exist per exact fact/scope. `expectedRevision` is the
 * caller's compare-and-set witness for change and release; `null` means the operation expects no
 * active override. An unresolved, conflicting, or already-decided state is never last-write-wins.
 */
export type CatalogLocalOverrideTransitionDecision =
  | { readonly nextRevision: bigint; readonly status: 'PROCEED' }
  | { readonly reason: string; readonly status: 'FORBIDDEN_FACT' }
  | { readonly reason: string; readonly status: 'PERMISSION_REQUIRED' }
  | { readonly reason: string; readonly status: 'NO_ACTIVE_OVERRIDE' }
  | { readonly reason: string; readonly status: 'ALREADY_ACTIVE' }
  | { readonly reason: string; readonly status: 'ALREADY_RELEASED' }
  | { readonly reason: string; readonly status: 'STALE_EDITOR' }
  | { readonly reason: string; readonly status: 'INDETERMINATE' };

export const decideCatalogLocalOverrideTransition = (input: {
  readonly authorized: boolean;
  readonly expectedRevision: bigint | null;
  readonly operation: CatalogLocalOverrideOperation;
  readonly overrides: readonly CatalogLocalOverride<unknown>[];
  readonly scope: CatalogFactScope;
}): CatalogLocalOverrideTransitionDecision => {
  if (!isCatalogLocalOverrideFactKeyAllowed(input.scope.factKey)) {
    return {
      reason: 'Local Override cannot hold a fact owned by another application',
      status: 'FORBIDDEN_FACT',
    };
  }
  if (!input.authorized) {
    return {
      reason: 'Local Override requires its own verified operation permission',
      status: 'PERMISSION_REQUIRED',
    };
  }
  const scoped = input.overrides.filter((override) => sameScope(override.scope, input.scope));
  if (scoped.length === 0) {
    return input.operation === 'ACTIVATE'
      ? { nextRevision: 1n, status: 'PROCEED' }
      : { reason: 'No override revision exists for this exact Catalog fact', status: 'NO_ACTIVE_OVERRIDE' };
  }
  let latestRevision = scoped[0]?.revision ?? 0n;
  for (const override of scoped) {
    if (override.revision > latestRevision) {
      latestRevision = override.revision;
    }
  }
  const latest = scoped.filter((override) => override.revision === latestRevision);
  const [latestOverride] = latest;
  if (latestOverride === undefined) {
    return { reason: 'Override revision state is unavailable', status: 'INDETERMINATE' };
  }
  if (latest.length > 1) {
    return { reason: 'Conflicting overrides share the latest revision', status: 'INDETERMINATE' };
  }
  if (scoped.some((override) => override.lifecycle === 'ACTIVE' && override.revision !== latestRevision)) {
    return { reason: 'More than one active override revision exists', status: 'INDETERMINATE' };
  }
  const currentActive = latestOverride.lifecycle === 'ACTIVE' ? latestOverride : null;
  if (input.operation === 'ACTIVATE') {
    return currentActive === null
      ? { nextRevision: latestRevision + 1n, status: 'PROCEED' }
      : { reason: 'An override is already active for this exact Catalog fact', status: 'ALREADY_ACTIVE' };
  }
  if (currentActive === null) {
    return latestOverride.lifecycle === 'RELEASED'
      ? { reason: 'The latest override revision is already released', status: 'ALREADY_RELEASED' }
      : { reason: 'No active override exists for this exact Catalog fact', status: 'NO_ACTIVE_OVERRIDE' };
  }
  if (input.expectedRevision === null || input.expectedRevision !== currentActive.revision) {
    return { reason: 'The override was changed by another editor', status: 'STALE_EDITOR' };
  }
  return { nextRevision: latestRevision + 1n, status: 'PROCEED' };
};
