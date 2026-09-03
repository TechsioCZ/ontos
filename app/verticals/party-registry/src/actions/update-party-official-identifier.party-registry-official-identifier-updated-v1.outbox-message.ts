/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-official-identifier-updated-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-official-identifier-updated-v1';

export const UpdatePartyOfficialIdentifierPartyRegistryOfficialIdentifierUpdatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type UpdatePartyOfficialIdentifierPartyRegistryOfficialIdentifierUpdatedV1OutboxPayload =
  OutboxPayload;
export const UpdatePartyOfficialIdentifierPartyRegistryOfficialIdentifierUpdatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const UpdatePartyOfficialIdentifierPartyRegistryOfficialIdentifierUpdatedV1OutboxTopic =
  outboxTopic;

export const createUpdatePartyOfficialIdentifierPartyRegistryOfficialIdentifierUpdatedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      UpdatePartyOfficialIdentifierPartyRegistryOfficialIdentifierUpdatedV1OutboxProducerModuleKey,
    topic: UpdatePartyOfficialIdentifierPartyRegistryOfficialIdentifierUpdatedV1OutboxTopic,
  });
