/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-counterparty-role-ended-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-counterparty-role-ended-v1';

export const CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxPayload = OutboxPayload;
export const CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxTopic = outboxTopic;

export const createCounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxProducerModuleKey,
  topic: CounterpartyRoleEndPartyRegistryCounterpartyRoleEndedV1OutboxTopic,
});
