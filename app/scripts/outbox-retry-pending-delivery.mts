#!/usr/bin/env node
/** After repairing a dependency, request the next attempt of one failed pending delivery without changing its debt. */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { CoreDatabase } from '../packages/core-runtime/src/db/client.ts';
import { retryPendingOutboxDelivery } from '../packages/core-runtime/src/outbox/pending-delivery-retry.ts';
import { ApplicationCompositionAuthorityAdminDatabaseLive } from './application-composition-authority-publication.mts';
import { OutboxDeadDeliveryResolutionArgumentsSchema } from './outbox-dead-delivery.mts';

const command = Command.make('outbox-retry-pending-delivery', {
  messageId: Flag.String('message-id'),
  operator: Flag.String('operator'),
  reason: Flag.String('reason'),
  tenantId: Flag.String('tenant-id'),
  workerKey: Flag.String('worker-key'),
}, (flags) => Effect.gen(function* requestRetry() {
  // Reference and operator-evidence syntax is identical to dead-delivery operations; state admission is separate.
  const input = yield* Schema.decodeUnknownEffect(OutboxDeadDeliveryResolutionArgumentsSchema)(flags);
  const { executor } = yield* CoreDatabase;
  const receipt = yield* executor.transaction((transaction) => retryPendingOutboxDelivery(transaction, {
    outboxMessageId: input.messageId, tenantId: input.tenantId, workerKey: input.workerKey,
    operatorName: input.operator, reason: input.reason,
  }));
  yield* Console.log(`[outbox-retry-pending-delivery] ${receipt.outcome}; attempt history and completion debt retained`);
})).pipe(Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive));

export const main = Command.run({ version: '1.0.0' })(command);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
    { disableErrorReporting: true },
  );
}
