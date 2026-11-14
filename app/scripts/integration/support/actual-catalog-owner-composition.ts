import { Effect } from 'effect';

import type { RegisteredActionOwnerV2 } from '../../../packages/core-runtime/src/access/approvals/registered-action-source-v2.ts';
import type { CoreDatabaseExecutor } from '../../../packages/core-runtime/src/db/types.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../../packages/core-runtime/src/modules/active-application-composition.ts';
import { publishTestApplicationCompositionAuthority } from '../../../packages/core-runtime/src/testing/owner-evidence.ts';
import { ultramodernDeliveryUnit } from '../../../verticals/catalog/shared/ultramodern-build.ts';
import { deriveActualCatalogCompositionSnapshot } from '../../../verticals/catalog/tests/support/actual-catalog-composition.fixture.ts';
import { catalogBackendRegistration } from '../../../verticals/catalog/vertical.runtime-declaration.ts';

/** The app root whose topology and Catalog SOURCE declarations the projection reads. */
const APP_ROOT = new URL('../../../', import.meta.url).pathname;

/**
 * The actual original Catalog owner release for a disposable database.
 *
 * `deriveActualCatalogCompositionSnapshot` is the one existing projection of the shipped
 * Catalog backend registration (its Actions, operation contracts and requirements) plus the observed Module
 * Federation bytes; it states its own SOURCE-only limitation and invents no deployed receipt. This
 * fixture publishes that snapshot as the database's active Application Composition — the row
 * `lockApplicationCompositionAuthority` fences every owner write against — and hands back the owner
 * release `makeActionApprovalLifecycleV2` admits registrations through.
 *
 * The publishing connection must be the administrative role: the runtime role holds SELECT only on
 * `core.application_composition_authority` (RLS).
 */
export const publishActualCatalogOwnerComposition = Effect.fn('IntegrationFixture.publishCatalogOwner')(
  function* publishActualCatalogOwnerComposition(executor: CoreDatabaseExecutor) {
    const snapshot: ActiveApplicationCompositionSnapshot = yield* deriveActualCatalogCompositionSnapshot(APP_ROOT);
    yield* publishTestApplicationCompositionAuthority(executor, snapshot);
    const owner: RegisteredActionOwnerV2 = {
      applicationComposition: { load: Effect.succeed(snapshot) },
      expectedDeployment: ultramodernDeliveryUnit,
      ownerRegistration: catalogBackendRegistration,
    };
    const owners: readonly RegisteredActionOwnerV2[] = [owner];
    return { owner, owners, snapshot };
  },
);
