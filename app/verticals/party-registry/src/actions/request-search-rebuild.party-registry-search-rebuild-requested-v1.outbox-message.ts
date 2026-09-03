import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-search-rebuild-requested-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-search-rebuild-requested-v1';

export { OutboxPayloadSchema as RequestSearchRebuildPartyRegistrySearchRebuildRequestedV1OutboxPayloadSchema } from '@app/party-registry/outbox/party-registry-search-rebuild-requested-v1';
export type RequestSearchRebuildPartyRegistrySearchRebuildRequestedV1OutboxPayload = OutboxPayload;
export const RequestSearchRebuildPartyRegistrySearchRebuildRequestedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RequestSearchRebuildPartyRegistrySearchRebuildRequestedV1OutboxTopic = outboxTopic;

export const createRequestSearchRebuildPartyRegistrySearchRebuildRequestedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    RequestSearchRebuildPartyRegistrySearchRebuildRequestedV1OutboxProducerModuleKey,
  topic: RequestSearchRebuildPartyRegistrySearchRebuildRequestedV1OutboxTopic,
});
