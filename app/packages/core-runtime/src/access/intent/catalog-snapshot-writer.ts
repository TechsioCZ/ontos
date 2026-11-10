import { Clock, Context, DateTime, Effect, Layer, Option, Result } from 'effect';

import type { AccessCatalogModule } from '../../authorization/access-declaration.ts';
import { releaseRefusal } from '../catalog/errors.ts';
import type { AccessCatalogReleaseError } from '../catalog/errors.ts';
import { buildAccessCatalogRelease } from '../catalog/release.ts';
import type { AccessChangesStoreError } from '../changes/persistence/errors/index.ts';
import { AccessChangesStore } from '../changes/persistence/store.ts';
import type { ModuleKey } from '../ids.ts';
import type { CatalogSnapshot } from '../model.ts';

/*
 * The initial release of the configurable catalog (O1, O67-Q7). A release is global — one per declaration
 * set, shared by every tenant — so this writer is the one place a release is published, and it publishes
 * exactly once: while nothing is released yet it publishes every declaration of the modules the tenant has
 * installed. After that, every later release is the deployment's own catalog, published at release
 * activation (`../release/activation.ts`): "Plný přístup" follows it and every other role adopts it through
 * Novinky, and no release ever rebuilds the snapshot a role is already pinned to.
 *
 * Nothing here decides access: publishing a capability makes it configurable, and grants nobody anything.
 */

export interface EnsureInitialReleaseRequest {
  /** The tenant's installations: a module the tenant does not have is not published (O7, O67-Q7). */
  readonly installedModuleKeys: readonly ModuleKey[];
  /** Every module the running composition declares; only the installed ones enter the release. */
  readonly modules: readonly AccessCatalogModule[];
}

export interface AccessCatalogSnapshotWriterService {
  /** The release a role revision must pin: the current one, published from intent when none exists. */
  readonly ensureInitialRelease: (
    request: EnsureInitialReleaseRequest,
  ) => Effect.Effect<CatalogSnapshot, AccessCatalogReleaseError>;
}

const storeRefusal = (error: AccessChangesStoreError): AccessCatalogReleaseError =>
  releaseRefusal('access_catalog_release_store_refused', `${error.code}: ${error.reason}`);

const now = Effect.fn('AccessCatalogSnapshotWriter.now')(function* nowEffect() {
  const millis = yield* Clock.currentTimeMillis;
  return DateTime.toDateUtc(DateTime.makeUnsafe(millis));
});

export class AccessCatalogSnapshotWriter extends Context.Service<
  AccessCatalogSnapshotWriter,
  AccessCatalogSnapshotWriterService
>()('@app/core-runtime/access/intent/catalog-snapshot-writer/AccessCatalogSnapshotWriter') {}

/**
 * The catalog writer of the process, over L52's Novinky store. A published release is never replaced here:
 * the first release is the catalog every role revision of every tenant pins, so a second bootstrap
 * publishes nothing and pins what exists.
 */
export const AccessCatalogSnapshotWriterLive: Layer.Layer<AccessCatalogSnapshotWriter, never, AccessChangesStore> =
  Layer.effect(
    AccessCatalogSnapshotWriter,
    Effect.gen(function* accessCatalogSnapshotWriterLayer() {
      const store = yield* AccessChangesStore;
      const ensureInitialRelease: AccessCatalogSnapshotWriterService['ensureInitialRelease'] = Effect.fn(
        'AccessCatalogSnapshotWriter.ensureInitialRelease',
      )(function* ensureInitialReleaseEffect(request: EnsureInitialReleaseRequest) {
        const published = yield* store.loadPublishedCatalog().pipe(Effect.mapError(storeRefusal));
        if (Option.isSome(published)) {
          return published.value;
        }
        const release = buildAccessCatalogRelease({
          installedModuleKeys: request.installedModuleKeys,
          modules: request.modules,
          publishedAt: yield* now(),
        });
        if (Result.isFailure(release)) {
          return yield* release.failure;
        }
        // The release identity is its digest, so a concurrent bootstrap that published this same content
        // resolves to the row it created instead of overwriting it (D3).
        yield* store.publishCatalog({ snapshot: release.success }).pipe(Effect.mapError(storeRefusal));
        return release.success;
      });
      return Object.freeze({ ensureInitialRelease });
    }),
  );
