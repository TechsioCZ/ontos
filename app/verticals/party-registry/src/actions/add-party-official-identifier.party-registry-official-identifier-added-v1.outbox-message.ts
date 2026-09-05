/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-official-identifier-added-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-official-identifier-added-v1';

export const AddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type AddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxPayload =
  OutboxPayload;
export const AddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const AddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxTopic =
  outboxTopic;

export const createAddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    AddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxProducerModuleKey,
  topic: AddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxTopic,
});
