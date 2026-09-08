import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-counterparty-role-added-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-counterparty-role-added-v1';

const CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxTopic =
  outboxTopic;

export const createCounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxProducerModuleKey,
    topic: CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxTopic,
  });
