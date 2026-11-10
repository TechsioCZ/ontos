import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { OperationalScope } from '../../../operations/context.ts';
import type { CatalogReleaseOrdering } from '../../catalog/release-ordering.ts';
import type { CatalogSnapshotId } from '../../ids.ts';
import type { AccessChangeItem, CatalogSnapshot } from '../../model.ts';
import type { RoleCellEdit } from '../role-edits.ts';
import type { AccessChangesStoreError } from './errors/index.ts';

/** Where a release activation left the catalog: the newest release and the one published just before it. */
export interface CatalogReleaseActivation {
  /** The newest release once the candidate was ordered: the candidate itself when it was published. */
  readonly newest: CatalogSnapshot;
  readonly ordering: CatalogReleaseOrdering;
  /** The release published immediately before `newest`; the Novinky of `newest` are its difference. */
  readonly previous: Option.Option<CatalogSnapshot>;
}

/** The platform actor of one tenant's release activation: a `system` principal of that tenant. */
export interface EnsureReleaseActorInput {
  readonly displayName: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/**
 * Everything one tenant takes from a release, written as one transaction: the Novinky items its other roles
 * may adopt and the successor revision through which "Plný přístup" follows the release.
 */
export interface RecordReleaseFollowInput {
  /** The release the preset successor is pinned to and the items are recorded for. */
  readonly catalogSnapshotId: CatalogSnapshotId;
  readonly decidedAt: Date;
  readonly items: readonly AccessChangeItem[];
  /** The preset's additions-only successor; absent when the preset already holds the whole release. */
  readonly presetEdit?: RoleCellEdit;
  /** The trusted system scope of the tenant's release actor, which authors the successor revision. */
  readonly scope: OperationalScope;
}

/**
 * The release-activation writes (`../release-activation.ts`). It is separate from `AccessChangesStore`
 * because nothing a person requests reaches it: only the platform publishes a deployment's release and lets
 * the full-access preset follow it. Every write is idempotent, so a retried activation repairs a failed one.
 */
export interface AccessReleaseStoreService {
  /**
   * Orders the candidate against every published release under one global lock and publishes it only when
   * it is newer (`orderCatalogRelease`). Two activations of overlapping deployments therefore decide one
   * after the other, and an older catalog never becomes the newest release.
   */
  readonly activateRelease: (
    candidate: CatalogSnapshot,
  ) => Effect.Effect<CatalogReleaseActivation, AccessChangesStoreError>;
  /** Creates the tenant's release actor when it is missing and refuses an identity that is not one. */
  readonly ensureReleaseActor: (input: EnsureReleaseActorInput) => Effect.Effect<void, AccessChangesStoreError>;
  /** The published releases with these identifiers, with their entries; unknown identifiers are skipped. */
  readonly loadReleases: (
    ids: readonly CatalogSnapshotId[],
  ) => Effect.Effect<readonly CatalogSnapshot[], AccessChangesStoreError>;
  /** The same ordering as `activateRelease`, read-only: what an activation would do, for a dry run. */
  readonly previewRelease: (
    candidate: CatalogSnapshot,
  ) => Effect.Effect<CatalogReleaseActivation, AccessChangesStoreError>;
  readonly recordReleaseFollow: (input: RecordReleaseFollowInput) => Effect.Effect<void, AccessChangesStoreError>;
}

export class AccessReleaseStore extends Context.Service<AccessReleaseStore, AccessReleaseStoreService>()(
  '@app/core-runtime/access/changes/persistence/release-store/AccessReleaseStore',
) {}
