import { coreSearchIngestionRegistryLayer } from '@app/core-runtime';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import {
  AccessProjectionWriterLive,
  AccessWriteJournalStoreLive,
  ActionAuthorizationLifecycleLive,
  CoreAuthorizationProjectionCompilerLive,
  CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
  coreSystemOutboxWorkers,
  corePeopleSearchOutboxWorkers,
  OutboxRuntimeLive,
  PeopleSearchProjectorLive,
  PeopleSearchSourceLive,
  peopleSearchIngestionRegistrations,
  SpiceDbConfigLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/outbox/core-system-worker';
import {
  ActiveApplicationCompositionConfigLive,
  CorePersistenceLive,
  CoreSearchProjectionStoreLive,
  CoreSearchWorkerSnapshotLive,
  DatabaseConfigLive,
  defineDatabaseIdentityEnrollment,
  defineOutboxWorkerEntry,
  makeDatabaseIdentityEnrollmentLive,
  OutboxRepositoryLive,
} from '@app/core-runtime/outbox/worker';
import { NodeCrypto } from '@effect/platform-node';
import { Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));
const compositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(
    ActiveApplicationCompositionSourceLive.pipe(
      Layer.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
        ),
      ),
    ),
  ),
);

const peopleSearchSnapshotLive = CoreSearchWorkerSnapshotLive.pipe(
  Layer.provide(coreSearchIngestionRegistryLayer(peopleSearchIngestionRegistrations)),
);
const peopleSearchLive = PeopleSearchProjectorLive.pipe(
  Layer.provide(
    Layer.mergeAll(PeopleSearchSourceLive.pipe(Layer.provide(peopleSearchSnapshotLive)), CoreSearchProjectionStoreLive),
  ),
);

/**
 * The one Core projection writer of this worker host. Its engine transport is deferred, so the host starts and
 * answers readiness without SpiceDB configured; the first reconcile that needs the engine opens it. The writer
 * owns the fence, journal, plan and verification, so every lifecycle wake-up is one tenant-wide reconcile.
 */
const projectionLive = AccessProjectionWriterLive.pipe(
  Layer.provide(
    Layer.mergeAll(CoreAuthorizationProjectionCompilerLive, AccessWriteJournalStoreLive, TenantIntentLoaderLive),
  ),
);
/** The Core lifecycle seam as this host composes it: the whole-tenant reconcile over the one writer. */
const authorizationLifecycleLive = ActionAuthorizationLifecycleLive.pipe(Layer.provide(projectionLive));

/** Public Node process root pinned to the same compiled Core/Shell deployment as its Actions. */
export const outboxWorkerEntry = defineOutboxWorkerEntry({
  claimOwnerPrefix: 'core.authorization-outbox-worker',
  expectedDeployment: ultramodernDeliveryUnit,
  layer: Layer.mergeAll(
    peopleSearchLive,
    OutboxRuntimeLive.pipe(Layer.provide(OutboxRepositoryLive)),
    authorizationLifecycleLive,
    Reactivity.layer,
  ).pipe(
    Layer.provideMerge(compositionLive),
    Layer.provide(CorePersistenceLive),
    Layer.provide(DatabaseConfigLive),
    Layer.provide(SpiceDbConfigLive),
    Layer.provideMerge(databaseIdentitiesLive),
    Layer.provide(NodeCrypto.layer),
  ),
  registrations: [...coreSystemOutboxWorkers, ...corePeopleSearchOutboxWorkers],
  subscriptions: CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
});
