/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-updated-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-updated-v1';

export const UpdatePartyPartyRegistryPartyUpdatedV1OutboxPayloadSchema = OutboxPayloadSchema;
export type UpdatePartyPartyRegistryPartyUpdatedV1OutboxPayload = OutboxPayload;
export const UpdatePartyPartyRegistryPartyUpdatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const UpdatePartyPartyRegistryPartyUpdatedV1OutboxTopic = outboxTopic;

export const createUpdatePartyPartyRegistryPartyUpdatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: UpdatePartyPartyRegistryPartyUpdatedV1OutboxProducerModuleKey,
  topic: UpdatePartyPartyRegistryPartyUpdatedV1OutboxTopic,
});
