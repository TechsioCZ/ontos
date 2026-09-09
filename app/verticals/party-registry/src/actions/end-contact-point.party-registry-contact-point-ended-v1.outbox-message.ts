import type { OutboxMessage } from '@app/core-runtime';
import { outboxProducerModuleKey, outboxTopic } from '@app/party-registry/outbox/party-registry-contact-point-ended-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-contact-point-ended-v1';

export const createEndContactPointPartyRegistryContactPointEndedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: outboxProducerModuleKey,
  topic: outboxTopic,
});
