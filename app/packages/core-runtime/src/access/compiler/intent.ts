import { Schema } from 'effect';

import type { ModuleKey, PrincipalId, TenantId } from '../ids.ts';
import type {
  AccessScopeRecord,
  AgentConnection,
  Assignment,
  CatalogSnapshotEntry,
  Delegation,
  Holder,
  RoleRevision,
} from '../model.ts';

/**
 * Intent the compiler projects, already read from PostgreSQL by the owning writer.
 *
 * The planner is pure: it reads no clock, no configuration and no database. Deadlines travel as
 * tuple expirations, so the same intent always produces the same graph (an idempotent re-plan is a
 * no-op, not a rewrite). Membership is part of intent because a scope's `access` permission is
 * built from it: a company grant authorizes only that company (guarantee 3).
 */
export interface ProjectionMemberIntent {
  readonly expiresAt?: Date;
  readonly holder: Holder;
}

export interface LegalEntityProjectionIntent {
  readonly accessAdmins: readonly PrincipalId[];
  readonly legalEntityId: string;
  readonly members: readonly ProjectionMemberIntent[];
  readonly suspended: readonly Holder[];
}

/**
 * The principal kind the intent declares, so the compiler can refuse to project a workload (O29,
 * O46). v2 relations accept a verified human and an agent only.
 */
export const AccessPrincipalKindSchema = Schema.Literals(['agent', 'human', 'integration', 'service', 'system']);
export type AccessPrincipalKind = typeof AccessPrincipalKindSchema.Type;

export interface ProjectionPrincipalIntent {
  readonly kind: AccessPrincipalKind;
  /** The `core.principals` identifier: humans and agents share the table but never the subject type. */
  readonly principalId: string;
}

/**
 * One pinned catalog entry of the snapshot the projected role revisions were saved against (O1).
 *
 * The planner validates every projected cell against its entry and takes the owning module key from
 * the entry, never from the capability key text: real module keys are dotted (`party.registry`), so
 * splitting a key at the first dot both hides every real module and links an uninstalled one whose
 * single-segment prefix happens to be installed (O27, guarantee 8).
 *
 * It is the model entry itself, so a writer passes `CatalogSnapshot.entries` through unchanged and
 * the compiler reads exactly what the role editor was shown.
 */
export type CatalogEntryProjectionIntent = CatalogSnapshotEntry;

/**
 * One module installed in a scope. The module key is its own identity and is never derived from a
 * capability key, so an installation names the module the product actually enabled.
 */
export interface ModuleInstallationIntent {
  readonly moduleKey: ModuleKey;
}

export interface ScopeProjectionIntent {
  readonly assignments: readonly Assignment[];
  /** Read fresh on every decision through the compiler; it never becomes a relationship. */
  readonly connections: readonly AgentConnection[];
  readonly delegations: readonly Delegation[];
  readonly installations: readonly ModuleInstallationIntent[];
  /** The pinned revision of each role that has a live assignment here, at most one per role. */
  readonly roleRevisions: readonly RoleRevision[];
  readonly scope: AccessScopeRecord;
}

export interface TenantProjectionIntent {
  /**
   * Every catalog entry this tenant's role cells reference. A cell whose key has no entry is refused
   * instead of projected, so a removed, unknown or unpublished capability can never be granted.
   */
  readonly catalogEntries: readonly CatalogEntryProjectionIntent[];
  /**
   * The tenant unit is reconciled whole, so this intent carries every member, owner, legal entity and
   * scope of the tenant. A partial intent is not a licence to delete the rest: `complete` is a type
   * requirement, and the reconcile compares each unit against the whole intent (D13).
   */
  readonly coverage: 'complete';
  readonly legalEntities: readonly LegalEntityProjectionIntent[];
  readonly members: readonly ProjectionMemberIntent[];
  readonly owners: readonly PrincipalId[];
  readonly principals: readonly ProjectionPrincipalIntent[];
  readonly scopes: readonly ScopeProjectionIntent[];
  readonly suspended: readonly Holder[];
  readonly tenantId: TenantId;
}

export interface AccessProjectionIntent {
  readonly tenants: readonly TenantProjectionIntent[];
}

/** The agent connection ceiling rides intent, not the graph: the decision engine intersects it. */
export interface ProjectedConnectionCeiling {
  readonly agentId: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly scopeId: string;
  readonly tenantId: string;
  readonly validUntil: Date;
}
