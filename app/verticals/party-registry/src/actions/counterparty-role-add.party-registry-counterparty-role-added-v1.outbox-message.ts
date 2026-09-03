/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-counterparty-role-added-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-counterparty-role-added-v1';

export const CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxPayload = OutboxPayload;
export const CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxTopic = outboxTopic;

export const createCounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxProducerModuleKey,
  topic: CounterpartyRoleAddPartyRegistryCounterpartyRoleAddedV1OutboxTopic,
});
