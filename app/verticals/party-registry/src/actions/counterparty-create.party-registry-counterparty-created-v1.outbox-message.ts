import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-counterparty-created-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-counterparty-created-v1';

const CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxTopic =
  outboxTopic;

export const createCounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxProducerModuleKey,
    topic: CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxTopic,
  });
