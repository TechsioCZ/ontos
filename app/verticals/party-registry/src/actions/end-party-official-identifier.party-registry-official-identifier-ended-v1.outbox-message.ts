/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-official-identifier-ended-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-official-identifier-ended-v1';

export const EndPartyOfficialIdentifierPartyRegistryOfficialIdentifierEndedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type EndPartyOfficialIdentifierPartyRegistryOfficialIdentifierEndedV1OutboxPayload =
  OutboxPayload;
export const EndPartyOfficialIdentifierPartyRegistryOfficialIdentifierEndedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const EndPartyOfficialIdentifierPartyRegistryOfficialIdentifierEndedV1OutboxTopic =
  outboxTopic;

export const createEndPartyOfficialIdentifierPartyRegistryOfficialIdentifierEndedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    EndPartyOfficialIdentifierPartyRegistryOfficialIdentifierEndedV1OutboxProducerModuleKey,
  topic: EndPartyOfficialIdentifierPartyRegistryOfficialIdentifierEndedV1OutboxTopic,
});
