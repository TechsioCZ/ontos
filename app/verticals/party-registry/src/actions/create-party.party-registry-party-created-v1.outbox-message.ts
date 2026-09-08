import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-created-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-created-v1';

const CreatePartyPartyRegistryPartyCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const CreatePartyPartyRegistryPartyCreatedV1OutboxTopic = outboxTopic;

export const createCreatePartyPartyRegistryPartyCreatedV1OutboxMessage = (
  payload: OutboxPayload
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    CreatePartyPartyRegistryPartyCreatedV1OutboxProducerModuleKey,
  topic: CreatePartyPartyRegistryPartyCreatedV1OutboxTopic,
});
