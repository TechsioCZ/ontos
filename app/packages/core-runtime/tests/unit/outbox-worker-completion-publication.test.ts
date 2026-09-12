import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  defineOutboxWorkerCompletion,
  outboxWorkerCompletionPublisherFor,
  OutboxWorkerCompletionPublicationError,
} from '../../src/outbox/completion-publication.ts';
import type { PersistOutboxWorkerCompletionInput } from '../../src/outbox/completion-publication.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const completionId = '30000000-0000-4000-8000-000000000001';
const actionInvocationId = '40000000-0000-4000-8000-000000000001';
const consumerModuleKey = 'commerce.customer-context';
const workerKey = 'commerce.customer-context.finalize-access-grant';
const eventType = 'commerce.customer-context.counterparty-access-granted.v1';

const GrantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('WorkerCompletionTestGrantId'),
  Schema.decodeTo(Schema.String),
);
const PayloadSchema = Schema.Struct({
  grantId: GrantIdSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

const definition = defineOutboxWorkerCompletion({
  consumerModuleKey,
  eventType,
  payloadSchema: PayloadSchema,
  producerModuleKey: consumerModuleKey,
  topic: eventType,
  workerKey,
});

const context = {
  attemptNumber: 1,
  claimId: 'claim-one',
  consumerModuleKey,
  deliveryId: 'delivery-one',
  domainEventId: 'request-event-one',
  messageId: 'request-message-one',
  producerModuleKey: consumerModuleKey,
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'commerce.customer-context.access-grant-authorization-mutation-requested.v1',
  workerKey,
} as const;

const input = {
  completionId,
  occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-09T10:00:00.000Z')),
  payloadJson: { grantId: completionId, revision: 2 },
  sourceActionInvocationId: actionInvocationId,
  subjectModuleKey: consumerModuleKey,
  subjectResourceId: completionId,
  subjectResourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
} as const;

it.effect('publishes only a schema-valid completion in the exact attested owner worker scope', () =>
  Effect.gen(function* publishExactCompletion() {
    const persisted: PersistOutboxWorkerCompletionInput[] = [];
    const publisher = outboxWorkerCompletionPublisherFor({
      context: attestOutboxWorkerHandlerContext(context),
      legalEntityId,
      persist: (completion) =>
        Effect.sync(() => {
          persisted.push(completion);
          return { domainEventId: completion.completionId, outcome: 'PUBLISHED' as const };
        }),
    });
    const result = yield* publisher.publish(definition, input);
    expect(result).toEqual({ domainEventId: completionId, outcome: 'PUBLISHED' });
    expect(persisted).toEqual([
      {
        ...input,
        eventType,
        legalEntityId,
        producerModuleKey: consumerModuleKey,
        tenantId,
        topic: eventType,
      },
    ]);
  }),
);

it.effect('rejects caller-created worker context before persistence', () =>
  Effect.gen(function* rejectUnverifiedContext() {
    let calls = 0;
    const publisher = outboxWorkerCompletionPublisherFor({
      context,
      legalEntityId,
      persist: () =>
        Effect.sync(() => {
          calls += 1;
          return { domainEventId: completionId, outcome: 'PUBLISHED' as const };
        }),
    });
    const failure = yield* Effect.flip(publisher.publish(definition, input));
    expect(failure).toBeInstanceOf(OutboxWorkerCompletionPublicationError);
    expect(failure.code).toBe('outbox_worker_completion_invalid');
    expect(calls).toBe(0);
  }),
);

it.effect('rejects a foreign worker, owner, event topic, or invalid payload', () =>
  Effect.gen(function* rejectCrossBoundaryCompletion() {
    let calls = 0;
    const persist = () =>
      Effect.sync(() => {
        calls += 1;
        return { domainEventId: completionId, outcome: 'PUBLISHED' as const };
      });
    const publisher = outboxWorkerCompletionPublisherFor({
      context: attestOutboxWorkerHandlerContext({
        ...context,
        workerKey: `${workerKey}-other`,
      }),
      legalEntityId,
      persist,
    });
    const wrongWorker = yield* Effect.flip(publisher.publish(definition, input));
    expect(wrongWorker.code).toBe('outbox_worker_completion_invalid');

    const exactPublisher = outboxWorkerCompletionPublisherFor({
      context: attestOutboxWorkerHandlerContext(context),
      legalEntityId,
      persist,
    });
    const badPayload = yield* Effect.flip(
      exactPublisher.publish(definition, {
        ...input,
        payloadJson: { grantId: 'not-a-uuid', revision: 1 },
      }),
    );
    expect(badPayload.code).toBe('outbox_worker_completion_invalid');
    expect(calls).toBe(0);
  }),
);

it('rejects definitions that can publish as another owner or under a different topic', () => {
  expect(() =>
    defineOutboxWorkerCompletion({
      consumerModuleKey,
      eventType,
      payloadSchema: PayloadSchema,
      producerModuleKey: 'foreign.module',
      topic: eventType,
      workerKey,
    }),
  ).toThrow(OutboxWorkerCompletionPublicationError);
  expect(() =>
    defineOutboxWorkerCompletion({
      consumerModuleKey,
      eventType,
      payloadSchema: PayloadSchema,
      producerModuleKey: consumerModuleKey,
      topic: `${eventType}-other`,
      workerKey,
    }),
  ).toThrow(OutboxWorkerCompletionPublicationError);
});
