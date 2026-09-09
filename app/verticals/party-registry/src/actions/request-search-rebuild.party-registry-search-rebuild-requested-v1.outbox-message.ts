import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-search-rebuild-requested-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-search-rebuild-requested-v1';

export const createRequestSearchRebuildPartyRegistrySearchRebuildRequestedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: outboxProducerModuleKey,
  topic: outboxTopic,
});
