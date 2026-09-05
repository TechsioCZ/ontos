/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-unarchived-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-unarchived-v1';

export const UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxPayloadSchema = OutboxPayloadSchema;
export type UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxPayload = OutboxPayload;
export const UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxTopic = outboxTopic;

export const createUnarchivePartyPartyRegistryPartyUnarchivedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxProducerModuleKey,
  topic: UnarchivePartyPartyRegistryPartyUnarchivedV1OutboxTopic,
});
