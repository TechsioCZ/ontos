import { makeDatabaseIdentityEnrollmentLive } from '@app/core-runtime';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import {
  ActionAuthorizationLifecycleLive,
  CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
  coreSystemOutboxWorkers,
  OutboxRuntimeLive,
  ScopedRoleMembershipLifecycleLive,
  SpiceDbConfigLive,
} from '@app/core-runtime/outbox/core-system-worker';
import {
  ActiveApplicationCompositionConfigLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  defineOutboxWorkerEntry,
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

/** Public Node process root pinned to the same compiled Core/Shell deployment as its Actions. */
export const outboxWorkerEntry = defineOutboxWorkerEntry({
  claimOwnerPrefix: 'core.authorization-outbox-worker',
  expectedDeployment: ultramodernDeliveryUnit,
  layer: Layer.mergeAll(
    OutboxRuntimeLive.pipe(Layer.provide(OutboxRepositoryLive)),
    ActionAuthorizationLifecycleLive.pipe(
      Layer.provide(ScopedRoleMembershipLifecycleLive),
      Layer.provide(SpiceDbConfigLive),
    ),
    Reactivity.layer,
  ).pipe(
    Layer.provideMerge(compositionLive),
    Layer.provide(CorePersistenceLive),
    Layer.provide(DatabaseConfigLive),
    Layer.provideMerge(databaseIdentitiesLive),
    Layer.provide(NodeCrypto.layer),
  ),
  registrations: coreSystemOutboxWorkers,
  subscriptions: CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
});
