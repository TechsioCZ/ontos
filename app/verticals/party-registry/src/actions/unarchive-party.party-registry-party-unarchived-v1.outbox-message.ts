import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-unarchived-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-unarchived-v1';

const UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxTopic = outboxTopic;

export const createUnarchivePartyPartyRegistryPartyUnarchivedV1OutboxMessage = (
  payload: OutboxPayload
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxProducerModuleKey,
  topic: UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxTopic,
});
