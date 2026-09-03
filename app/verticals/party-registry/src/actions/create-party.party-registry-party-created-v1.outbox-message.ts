/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-created-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-created-v1';

export const CreatePartyPartyRegistryPartyCreatedV1OutboxPayloadSchema = OutboxPayloadSchema;
export type CreatePartyPartyRegistryPartyCreatedV1OutboxPayload = OutboxPayload;
export const CreatePartyPartyRegistryPartyCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CreatePartyPartyRegistryPartyCreatedV1OutboxTopic = outboxTopic;

export const createCreatePartyPartyRegistryPartyCreatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CreatePartyPartyRegistryPartyCreatedV1OutboxProducerModuleKey,
  topic: CreatePartyPartyRegistryPartyCreatedV1OutboxTopic,
});
