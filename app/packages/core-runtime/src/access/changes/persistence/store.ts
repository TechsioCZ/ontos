import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { OperationalScope } from '../../../operations/context.ts';
import type { CoreTransaction } from '../../../db/types.ts';
import type { AssignmentIncarnationId, CatalogSnapshotId } from '../../ids.ts';
import type { AccessChangeDecision, AccessChangeItem, CatalogSnapshot, Role, RoleRevision } from '../../model.ts';
import type { AdoptionPlan, DeclinePlan } from '../adoption.ts';
import type { ChangeItemPlan } from '../items.ts';
import type { RoleCellEdit, RoleWithRevision } from '../role-edits.ts';
import type { UndoPlan } from '../undo.ts';
import type { AccessChangesStoreError } from './errors/index.ts';

/**
 * Everything the Novinky screens and the Access change plans read about one tenant's intent. It is
 * one snapshot of the tenant, read in one transaction under the tenant's own scope, so the plan that
 * follows is built from a consistent state rather than from separate reads that could disagree.
 */
export interface AccessChangesState {
  /** Append-only decisions, oldest first. */
  readonly decisions: readonly AccessChangeDecision[];
  readonly items: readonly AccessChangeItem[];
  /** Every revision of every role in role and revision order; an undo reads history from here (R2-M8). */
  readonly revisions: readonly RoleRevision[];
  /** Each role with the revision that currently expresses its intent. */
  readonly roles: readonly RoleWithRevision[];
}

/**
 * What one publish did. The release catalog is global and append-only, so a retry of the same
 * digest writes nothing and reports `inserted: false`; an interrupted publish is repaired by
 * retrying it, never by a second release with the same identity (D3).
 */
export interface CatalogPublication {
  readonly catalogSnapshotId: CatalogSnapshotId;
  readonly inserted: boolean;
}

export interface PublishCatalogInput {
  /** The release as the module's published declarations produced it; entries are the catalog only. */
  readonly snapshot: CatalogSnapshot;
}

export interface RecordRoleInput {
  readonly revision: RoleRevision;
  readonly role: Role;
  /**
   * The trusted request scope: the tenant whose Novinky state is written and the person the
   * authenticated request names. The role must belong to that tenant and be created by that person.
   */
  readonly scope: OperationalScope;
}

/**
 * One successor revision of an existing role, as the role editor planned it. The source revision it
 * was planned against is part of the edit, so a plan built from an older read is a conflict and never
 * a fork of the role's history (D23, guarantee 5).
 */
export interface RecordRoleRevisionInput {
  /** The release the revision is pinned to; the cells it holds were validated against it (O1). */
  readonly catalogSnapshotId: CatalogSnapshotId;
  /** The instant Core records the decision at, never a time the request supplied. */
  readonly decidedAt: Date;
  readonly edit: RoleCellEdit;
  /**
   * The live holders a delegated manager's authority was checked against. Under the role's write lock
   * the store refuses the edit when the role has gained a holder since, because the envelope never
   * saw that person. Absent when a permanent basis authorized the edit, which reaches anyone.
   */
  readonly expectedHolders?: readonly AssignmentIncarnationId[];
  /** The grantor assignments covering the delegated edit's cells, locked and re-checked as it commits. */
  readonly grantorIncarnationIds?: readonly AssignmentIncarnationId[];
  /** The trusted request scope: its tenant is written and its person is the author (O66). */
  readonly scope: OperationalScope;
}

export interface RecordChangeItemsInput {
  readonly plan: ChangeItemPlan;
  readonly scope: OperationalScope;
}

/**
 * A decision writes the revisions the plan computed, pinned to the release being adopted. Each
 * revision is written only over the revision it was planned against, so a plan built from an older
 * read is a conflict and never a fork of the role's history.
 */
export interface RecordAdoptionInput {
  readonly catalogSnapshotId: CatalogSnapshotId;
  readonly plan: AdoptionPlan;
  readonly scope: OperationalScope;
}

export interface RecordDeclineInput {
  readonly plan: DeclinePlan;
  readonly scope: OperationalScope;
}

export interface RecordUndoInput {
  readonly catalogSnapshotId: CatalogSnapshotId;
  readonly plan: UndoPlan;
  readonly scope: OperationalScope;
}

/**
 * Persistence for the Access changes area: the release catalog, the tenant's roles and their
 * append-only revisions, and the Novinky items and decisions. It stores decisions and never takes
 * them: which item may be adopted, whether a preview is stale, and who may decide are all decided by
 * the plans, so this port can add nothing to a decision that a person did not already make.
 *
 * Every write is one transaction in the request's own tenant scope, and every refusal is either a
 * conflict the caller repairs by re-reading or retryable unavailability. The Drizzle implementation
 * and its layer live in `drizzle-store.ts`; no consumer imports a database executor from here.
 */
export interface AccessChangesStoreService {
  /**
   * The newest published release: what a role revision is pinned to and what is adoptable (O1). A
   * caller that already holds a transaction reads the release through that one (O75), so the entries
   * a proposal is parked against are the entries its own transaction sees.
   */
  readonly loadPublishedCatalog: (
    transaction?: CoreTransaction,
  ) => Effect.Effect<Option.Option<CatalogSnapshot>, AccessChangesStoreError>;
  /** One tenant's intent, visible only under that tenant's installed scope. */
  readonly loadTenantChanges: (scope: OperationalScope) => Effect.Effect<AccessChangesState, AccessChangesStoreError>;
  /** Publishes one release; a retry of the same digest is a no-op, a different one is refused. */
  readonly publishCatalog: (input: PublishCatalogInput) => Effect.Effect<CatalogPublication, AccessChangesStoreError>;
  readonly recordAdoption: (input: RecordAdoptionInput) => Effect.Effect<void, AccessChangesStoreError>;
  /** Records the pending items a release created. Listing an item grants nothing (guarantee 2). */
  readonly recordChangeItems: (input: RecordChangeItemsInput) => Effect.Effect<void, AccessChangesStoreError>;
  readonly recordDecline: (input: RecordDeclineInput) => Effect.Effect<void, AccessChangesStoreError>;
  /** Records a role with its first revision; a role never exists without the revision it holds. */
  readonly recordRole: (input: RecordRoleInput) => Effect.Effect<void, AccessChangesStoreError>;
  /**
   * Records the successor revision the role editor planned, in the caller's own tenant scope. It is the
   * same writer an adoption uses: it refuses a source revision that is no longer current, re-points
   * every live holder of the role and moves the grant incarnations the added and removed cells name.
   */
  readonly recordRoleRevision: (input: RecordRoleRevisionInput) => Effect.Effect<void, AccessChangesStoreError>;
  readonly recordUndo: (input: RecordUndoInput) => Effect.Effect<void, AccessChangesStoreError>;
}

export class AccessChangesStore extends Context.Service<AccessChangesStore, AccessChangesStoreService>()(
  '@app/core-runtime/access/changes/persistence/store/AccessChangesStore',
) {}
