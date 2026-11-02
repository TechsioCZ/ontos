import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { createPrepareOrderCommitmentCommerceOrderFinalizationWorkOutboxMessage } from '../../src/actions/prepare-order-commitment-commerce-order-finalization-work.outbox-message.ts';
import {
  harnessAdmittedRevision,
  orderLegalEntityId,
  orderProofRequestRef,
  runOrderRevalidation,
} from '../support/order-revalidation-work.ts';

it.effect('registers enqueued Order finalization work as composition completion debt for the admitted release', () =>
  Effect.gen(function* trackedFinalizationWork() {
    const [committed] = yield* runOrderRevalidation('PROOFS_PENDING');
    expect(committed?.evidence.outboxMessages).toHaveLength(1);
    expect(committed?.evidence.outboxMessages[0]).toEqual({
      completion: { consumerModuleKey: 'commerce.order', originalRevision: harnessAdmittedRevision },
      domainEventIndex: 0,
      message: createPrepareOrderCommitmentCommerceOrderFinalizationWorkOutboxMessage({
        intentRef: orderProofRequestRef,
        legalEntityId: orderLegalEntityId,
        stage: 'PROOF',
      }),
    });
    expect(committed?.evidence.domainEvents[0]?.eventType).toBe('commerce.order.finalization-work-requested.v1');
  }),
);

it.effect('creates no completion debt when revalidation leaves no finalization work', () =>
  Effect.gen(function* noFinalizationWork() {
    const [committed] = yield* runOrderRevalidation('FAILED');
    expect(committed?.evidence.outboxMessages).toEqual([]);
    expect(committed?.evidence.domainEvents).toEqual([]);
  }),
);
