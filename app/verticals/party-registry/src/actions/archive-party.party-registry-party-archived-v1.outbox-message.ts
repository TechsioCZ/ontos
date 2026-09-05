/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-archived-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-archived-v1';

export const ArchivePartyPartyRegistryPartyArchivedV1OutboxPayloadSchema = OutboxPayloadSchema;
export type ArchivePartyPartyRegistryPartyArchivedV1OutboxPayload = OutboxPayload;
export const ArchivePartyPartyRegistryPartyArchivedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ArchivePartyPartyRegistryPartyArchivedV1OutboxTopic = outboxTopic;

export const createArchivePartyPartyRegistryPartyArchivedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: ArchivePartyPartyRegistryPartyArchivedV1OutboxProducerModuleKey,
  topic: ArchivePartyPartyRegistryPartyArchivedV1OutboxTopic,
});
