import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import type { ActionCollectorError, ActionHandlerContext } from '@app/core-runtime';
import {
  OrderLegalEntityIdSchema,
  OrderResourceRefSchema,
} from '@app/commerce-order-contracts/verify-order-commitment-binding';
import { Effect, Schema } from 'effect';
import { createPrepareOrderCommitmentCommerceOrderFinalizationWorkOutboxMessage } from './prepare-order-commitment-commerce-order-finalization-work.outbox-message.ts';
import type { OutboxPayload } from '../../shared/outbox/commerce-order-finalization-work.ts';
import type { OrderCommitmentState } from '../../shared/domain/order-commitment.ts';

const moduleKey = 'commerce.order' as const;

export const orderCommitmentDomainEvents = {
  'commerce.order.commitment-command-completed.v1': Schema.Struct({
    attemptRef: CoreSearchResourceRefSchema,
    revision: Schema.Int,
    status: Schema.Literals(['READY', 'PRECOMMIT_FAILED', 'CANCELLED', 'COMMITTED']),
  }),
  'commerce.order.finalization-work-requested.v1': Schema.Struct({
    intentRef: OrderResourceRefSchema,
    legalEntityId: OrderLegalEntityIdSchema,
    stage: Schema.Literals(['PREPARE', 'PROOF', 'CONSUME']),
  }),
};
export const recordOrderCommitmentOperation: (
  context: Pick<ActionHandlerContext<typeof orderCommitmentDomainEvents>, 'addDomainEvent' | 'recordDataAccess'>,
  state: OrderCommitmentState,
) => Effect.Effect<void, ActionCollectorError> = Effect.fn('OrderCommitment.recordOperation')(function* recordOperation(
  context: Pick<ActionHandlerContext<typeof orderCommitmentDomainEvents>, 'addDomainEvent' | 'recordDataAccess'>,
  state: OrderCommitmentState,
) {
  const ref = state.attempt.binding.attemptRef;
  yield* context.recordDataAccess({
    accessKind: 'read',
    queryHash: `order-commitment:${ref.resourceId}:${state.attempt.revision}`,
    resultCount: 1,
    servingModuleKey: moduleKey,
    targetModuleKey: moduleKey,
    targetResourceId: ref.resourceId,
    targetResourceType: ref.resourceType,
  });
  yield* context.addDomainEvent({
    eventType: 'commerce.order.commitment-command-completed.v1',
    payloadJson: { attemptRef: ref, revision: state.attempt.revision, status: state.attempt.status },
    producerModuleKey: moduleKey,
    subjectModuleKey: moduleKey,
    subjectResourceId: ref.resourceId,
    subjectResourceType: ref.resourceType,
  });
});

/**
 * Event and pending work become durable in the same buyer Action transaction. The work is
 * composition completion debt, so publication waits for its delivery instead of draining under it.
 */
export const enqueueOrderFinalizationWork = Effect.fn('OrderCommitment.enqueueWork')(
  function* enqueueOrderFinalizationWork(
    context: Pick<
      ActionHandlerContext<typeof orderCommitmentDomainEvents>,
      'addDomainEvent' | 'addOutboxMessage' | 'recordDataAccess'
    >,
    payload: OutboxPayload,
  ) {
    const event = yield* context.addDomainEvent({
      eventType: 'commerce.order.finalization-work-requested.v1',
      payloadJson: payload,
      producerModuleKey: moduleKey,
      subjectModuleKey: moduleKey,
      subjectResourceId: payload.intentRef.resourceId,
      subjectResourceType: payload.intentRef.resourceType,
    });
    yield* context.addOutboxMessage(
      event,
      createPrepareOrderCommitmentCommerceOrderFinalizationWorkOutboxMessage(payload),
      { consumerModuleKey: moduleKey },
    );
    yield* context.recordDataAccess({
      accessKind: 'read',
      queryHash: `order-finalization:${payload.intentRef.resourceId}`,
      resultCount: 1,
      servingModuleKey: moduleKey,
      targetModuleKey: moduleKey,
      targetResourceId: payload.intentRef.resourceId,
      targetResourceType: payload.intentRef.resourceType,
    });
  },
);
