import type { OutboxMessage } from '@app/core-runtime';
import { outboxProducerModuleKey, outboxTopic } from '@app/party-registry/outbox/party-registry-relationship-ended-v1';
import type { OutboxPayloadJson } from '@app/party-registry/outbox/party-registry-relationship-ended-v1';

const EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxProducerModuleKey = outboxProducerModuleKey;
const EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxTopic = outboxTopic;

export const createEndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxMessage = (
  payload: OutboxPayloadJson,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxProducerModuleKey,
  topic: EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxTopic,
});
