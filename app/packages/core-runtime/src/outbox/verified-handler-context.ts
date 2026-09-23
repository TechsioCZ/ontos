import { Schema } from 'effect';

import type { OutboxWorkerHandlerContext } from './definition.ts';

class VerifiedOutboxWorkerHandlerContextValue implements OutboxWorkerHandlerContext {
  declare readonly actorPrincipalId?: string;
  declare readonly attemptNumber: number;
  declare readonly claimId: string;
  declare readonly consumerModuleKey?: string;
  // oxlint-disable-next-line effect-native/no-threaded-correlation-parameter -- Immutable persisted claim evidence copied into a Core-attested worker context, not ambient request threading.
  declare readonly correlationId?: string;
  declare readonly deliveryId: string;
  declare readonly domainEventId: string;
  declare readonly legalEntityScope?: 'forbidden' | 'required';
  declare readonly messageId: string;
  declare readonly producerModuleKey: string;
  declare readonly tenantId: string;
  declare readonly tenantSequenceNo: bigint;
  declare readonly topic: string;
  declare readonly workerKey: string;

  constructor(context: OutboxWorkerHandlerContext) {
    Object.assign(this, context);
    Object.freeze(this);
  }
}

const VerifiedOutboxWorkerHandlerContextSchema = Schema.instanceOf(VerifiedOutboxWorkerHandlerContextValue);

/** Core-private construction seam: caller-created context objects are not trusted worker claims. */
export const attestOutboxWorkerHandlerContext = (context: OutboxWorkerHandlerContext): OutboxWorkerHandlerContext =>
  new VerifiedOutboxWorkerHandlerContextValue(context);

export const isVerifiedOutboxWorkerHandlerContext = (context: OutboxWorkerHandlerContext): boolean =>
  Schema.is(VerifiedOutboxWorkerHandlerContextSchema)(context);
