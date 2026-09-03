/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-counterparty-created-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-counterparty-created-v1';

export const CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxPayload = OutboxPayload;
export const CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxTopic = outboxTopic;

export const createCounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxProducerModuleKey,
  topic: CounterpartyCreatePartyRegistryCounterpartyCreatedV1OutboxTopic,
});
