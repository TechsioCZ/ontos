import type { AccessMembershipStore } from '../access/intent/memberships.ts';
import type { AccessProjectionWriter } from '../access/intent/projection-writer.ts';
import type { AccessCatalogModule } from '../authorization/access-declaration.ts';
import type { TenantAccessBootstrap } from '../access/bootstrap/bootstrap-tenant-access.ts';
import type { CoreDatabase } from '../db/client.ts';

/*
 * What an installation run reads and writes, named once (CUTOVER-PLAN §3.4-3.5). A stage bootstrap, a
 * local development seed and an integration suite all create a tenant's first authority through the same
 * services over the same PostgreSQL: the bootstrap itself, the membership store it adds stage
 * accounts through, and the single writer it reconciles with. The *composition* of those services is a
 * process root's job — each run opens its own pool and its own engine transport — so this module carries
 * the requirement and the module set, never a `Layer`.
 *
 * The registered workload bindings (O73) are written through `writeWorkloadBindings` over the run's own
 * `CoreDatabase`, exactly as it writes the scopes, so they add no service to this requirement.
 */

/** The services one installation run needs, provided by the run's own composition root. */
export type InstallationRuntime = AccessMembershipStore | AccessProjectionWriter | CoreDatabase | TenantAccessBootstrap;

/** Core's own modules are never optional: the shell and the identity screens are served everywhere. */
const CORE_MODULE_PREFIX = 'core.';

/**
 * The modules a tenant installs: the modules the operator or the developer activated, plus Core's own,
 * because a tenant without `core.identity` or `core.shell` is a tenant nobody can sign in to. A vertical
 * the tenant does not have stays out, so its capabilities never enter the release (O7, O67-Q7).
 */
export const installedModuleKeysOf = (
  tenantModuleKeys: readonly string[],
  modules: readonly AccessCatalogModule[],
): readonly string[] =>
  [
    ...new Set([
      ...tenantModuleKeys,
      ...modules.flatMap(({ moduleId }) => (moduleId.startsWith(CORE_MODULE_PREFIX) ? [moduleId] : [])),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
