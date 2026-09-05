/* eslint-disable unicorn/prefer-export-from -- Generated action aliases intentionally bind stable action-specific names. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-relationship-updated-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-relationship-updated-v1';

export const UpdatePartyRelationshipPartyRegistryRelationshipUpdatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type UpdatePartyRelationshipPartyRegistryRelationshipUpdatedV1OutboxPayload = OutboxPayload;
export const UpdatePartyRelationshipPartyRegistryRelationshipUpdatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const UpdatePartyRelationshipPartyRegistryRelationshipUpdatedV1OutboxTopic = outboxTopic;

export const createUpdatePartyRelationshipPartyRegistryRelationshipUpdatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    UpdatePartyRelationshipPartyRegistryRelationshipUpdatedV1OutboxProducerModuleKey,
  topic: UpdatePartyRelationshipPartyRegistryRelationshipUpdatedV1OutboxTopic,
});
