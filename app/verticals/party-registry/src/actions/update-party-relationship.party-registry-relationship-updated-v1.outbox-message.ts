import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-relationship-updated-v1';
import type { OutboxPayloadJson } from '@app/party-registry/outbox/party-registry-relationship-updated-v1';

export const createUpdatePartyRelationshipPartyRegistryRelationshipUpdatedV1OutboxMessage =
  (payload: OutboxPayloadJson): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey: outboxProducerModuleKey,
    topic: outboxTopic,
  });
