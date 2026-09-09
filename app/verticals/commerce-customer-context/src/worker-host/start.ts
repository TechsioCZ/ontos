import {
  extractOutboxWorkerSubscriptions,
  startOutboxWorkerProcess,
} from '@app/core-runtime/outbox/worker';
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
  Layer.provide(outboxWorkerBusinessPermissionRelationshipMutationLive),
  Layer.provide(outboxWorkerContextAccessLive),
  Layer.provide(outboxWorkerRepositoryLive),
  Layer.provide(outboxWorkerCorePersistenceLive),
  Layer.provide(outboxWorkerDatabaseConfigLive),
);

export const startCommerceCustomerContextOutboxWorker = (): void =>
  startOutboxWorkerProcess<
    (typeof outboxWorkers)[number],
    Layer.Error<typeof outboxWorkerProcessLayer>
  >({
    claimOwnerPrefix: 'commerce.customer-context-outbox-worker',
    health: true,
    layer: outboxWorkerProcessLayer,
    registrations: outboxWorkers,
    subscriptions: outboxSubscriptions,
  });
