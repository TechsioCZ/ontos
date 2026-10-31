import { Effect } from 'effect';

import type { ActionRuntimeOptions } from '../../src/actions/runtime.ts';
import type { ContextAccess } from '../../src/permissions/context-access.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from './database-identities.ts';
import { openModuleEntrypointGateway } from './open-module-entrypoint-gateway.ts';
import { openModuleStateGate } from './open-module-state-gate.ts';

/**
 * Tenant-permission allow for suites that exercise unrelated Action mechanics. Core treats a declared
 * `tenantPermission` as unavailable when no ContextAccess is installed, so a suite running an action that
 * declares one must state the authority it assumes rather than inheriting an implicit allow.
 */
export const allowTenantPermissions: (typeof ContextAccess)['Service'] = {
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};

export const openActionRuntimeOptions = {
  databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
  moduleEntrypointGateway: openModuleEntrypointGateway,
  moduleStateGate: openModuleStateGate,
  // These fixtures test unrelated Action boundaries. Composition fencing has its own native
  // PostgreSQL suite; the fixture authority must never become the production default.
  lockCompositionAuthority: () => Effect.succeed([]),
  resolveCompositionRevision: () => Effect.succeed('a'.repeat(64)),
} satisfies Pick<
  ActionRuntimeOptions,
  | 'databaseIdentities'
  | 'moduleEntrypointGateway'
  | 'moduleStateGate'
  | 'lockCompositionAuthority'
  | 'resolveCompositionRevision'
>;
