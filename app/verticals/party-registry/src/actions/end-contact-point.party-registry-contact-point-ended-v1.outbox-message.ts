/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-contact-point-ended-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-contact-point-ended-v1';

export const EndContactPointPartyRegistryContactPointEndedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type EndContactPointPartyRegistryContactPointEndedV1OutboxPayload = OutboxPayload;
export const EndContactPointPartyRegistryContactPointEndedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const EndContactPointPartyRegistryContactPointEndedV1OutboxTopic = outboxTopic;

export const createEndContactPointPartyRegistryContactPointEndedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: EndContactPointPartyRegistryContactPointEndedV1OutboxProducerModuleKey,
  topic: EndContactPointPartyRegistryContactPointEndedV1OutboxTopic,
});
