import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-relationship-created-v1';
import type { OutboxPayloadJson } from '@app/party-registry/outbox/party-registry-relationship-created-v1';

const CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxTopic = outboxTopic;

export const createCreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxMessage = (
  payload: OutboxPayloadJson,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxProducerModuleKey,
  topic: CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxTopic,
});
