/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-party-fact-corrected-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-fact-corrected-v1';

export const CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxPayload = OutboxPayload;
export const CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxTopic = outboxTopic;

export const createCorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxProducerModuleKey,
  topic: CorrectPartyFactPartyRegistryPartyFactCorrectedV1OutboxTopic,
});
