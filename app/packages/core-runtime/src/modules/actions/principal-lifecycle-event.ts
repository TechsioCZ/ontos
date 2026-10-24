import { Effect, Result, Schema } from 'effect';

import type { ActionCollectorMethods } from '../../actions/context.ts';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '../../outbox/core-identity-principal-lifecycle-changed-v1.ts';

export const principalLifecycleDomainEvents = Object.freeze({ [outboxTopic]: OutboxPayloadSchema });
const decodePayload = Schema.decodeUnknownResult(OutboxPayloadSchema);

/** The event and wake-up are collected by the same Action transaction that changes the principal. */
export const recordPrincipalLifecycleChange = Effect.fn('PrincipalLifecycleEvent.recordPrincipalLifecycleChange')(
  function* recordPrincipalLifecycleChangeEffect(
    context: ActionCollectorMethods<typeof principalLifecycleDomainEvents>,
    principalId: string,
  ) {
    const payload = Result.getOrThrow(decodePayload({ data: { principalId } }));
    const event = yield* context.addDomainEvent({
      eventType: outboxTopic,
      payloadJson: payload,
      producerModuleKey: outboxProducerModuleKey,
      subjectModuleKey: outboxProducerModuleKey,
      subjectResourceId: principalId,
      subjectResourceType: 'principal',
    });
    yield* context.addOutboxMessage(event, {
      payloadJson: payload,
      producerModuleKey: outboxProducerModuleKey,
      topic: outboxTopic,
    });
  },
);
