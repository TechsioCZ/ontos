import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-counterparty-role-ended-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-counterparty-role-ended-v1';

const CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxTopic =
  outboxTopic;

export const createCounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxProducerModuleKey,
    topic: CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxTopic,
  });
