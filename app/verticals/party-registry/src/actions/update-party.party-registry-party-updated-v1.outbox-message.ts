import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-updated-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-updated-v1';

const UpdatePartyPartyRegistryPartyUpdatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const UpdatePartyPartyRegistryPartyUpdatedV1OutboxTopic = outboxTopic;

export const createUpdatePartyPartyRegistryPartyUpdatedV1OutboxMessage = (
  payload: OutboxPayload
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    UpdatePartyPartyRegistryPartyUpdatedV1OutboxProducerModuleKey,
  topic: UpdatePartyPartyRegistryPartyUpdatedV1OutboxTopic,
});
