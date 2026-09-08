import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-archived-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-archived-v1';

const ArchivePartyPartyRegistryPartyArchivedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ArchivePartyPartyRegistryPartyArchivedV1OutboxTopic = outboxTopic;

export const createArchivePartyPartyRegistryPartyArchivedV1OutboxMessage = (
  payload: OutboxPayload
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    ArchivePartyPartyRegistryPartyArchivedV1OutboxProducerModuleKey,
  topic: ArchivePartyPartyRegistryPartyArchivedV1OutboxTopic,
});
