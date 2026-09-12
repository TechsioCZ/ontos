import { extractOutboxWorkerSubscriptions, startOutboxWorkerProcess } from '@app/core-runtime/outbox/worker';
import { Layer } from 'effect';
import { outboxWorkers } from '../workers/index.ts';
import {
  outboxWorkerBusinessPermissionRelationshipMutationLive,
  outboxWorkerContextAccessLive,
  outboxWorkerCorePersistenceLive,
  outboxWorkerDatabaseConfigLive,
  outboxWorkerLayer as outboxWorkerDefinitionLayer,
  outboxWorkerRepositoryLive,
} from './layer.ts';

const outboxSubscriptions = extractOutboxWorkerSubscriptions(outboxWorkers);
const outboxWorkerProcessLayer = outboxWorkerDefinitionLayer.pipe(
  /* oxlint-disable effect-native/no-layer-provide-in-library -- This executable worker composition root supplies the final process dependencies before startup. */
  Layer.provide(outboxWorkerBusinessPermissionRelationshipMutationLive),
  Layer.provide(outboxWorkerContextAccessLive),
  Layer.provide(outboxWorkerRepositoryLive),
  Layer.provide(outboxWorkerCorePersistenceLive),
  Layer.provide(outboxWorkerDatabaseConfigLive),
  /* oxlint-enable effect-native/no-layer-provide-in-library */
);

export const startCommerceCustomerContextOutboxWorker = (): void =>
  startOutboxWorkerProcess<(typeof outboxWorkers)[number], Layer.Error<typeof outboxWorkerProcessLayer>>({
    claimOwnerPrefix: 'commerce.customer-context-outbox-worker',
    health: true,
    layer: outboxWorkerProcessLayer,
    registrations: outboxWorkers,
    subscriptions: outboxSubscriptions,
  });
