/* eslint-disable unicorn/prefer-export-from -- Codesmith keeps stable action-local aliases for the public outbox contract. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-contact-point-updated-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-contact-point-updated-v1';

export const UpdateContactPointPartyRegistryContactPointUpdatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type UpdateContactPointPartyRegistryContactPointUpdatedV1OutboxPayload = OutboxPayload;
export const UpdateContactPointPartyRegistryContactPointUpdatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const UpdateContactPointPartyRegistryContactPointUpdatedV1OutboxTopic = outboxTopic;

export const createUpdateContactPointPartyRegistryContactPointUpdatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: UpdateContactPointPartyRegistryContactPointUpdatedV1OutboxProducerModuleKey,
  topic: UpdateContactPointPartyRegistryContactPointUpdatedV1OutboxTopic,
});
