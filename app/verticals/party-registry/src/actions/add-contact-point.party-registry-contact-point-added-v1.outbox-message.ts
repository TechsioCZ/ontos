/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-contact-point-added-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-contact-point-added-v1';

export const AddContactPointPartyRegistryContactPointAddedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type AddContactPointPartyRegistryContactPointAddedV1OutboxPayload = OutboxPayload;
export const AddContactPointPartyRegistryContactPointAddedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const AddContactPointPartyRegistryContactPointAddedV1OutboxTopic = outboxTopic;

export const createAddContactPointPartyRegistryContactPointAddedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: AddContactPointPartyRegistryContactPointAddedV1OutboxProducerModuleKey,
  topic: AddContactPointPartyRegistryContactPointAddedV1OutboxTopic,
});
