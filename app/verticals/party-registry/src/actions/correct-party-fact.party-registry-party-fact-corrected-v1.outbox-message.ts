import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-fact-corrected-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-fact-corrected-v1';

const CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxTopic =
  outboxTopic;

export const createCorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxProducerModuleKey,
    topic: CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxTopic,
  });
