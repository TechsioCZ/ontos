/* eslint-disable unicorn/prefer-export-from -- Generated action aliases intentionally bind stable action-specific names. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-relationship-created-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-relationship-created-v1';

export const CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxPayload = OutboxPayload;
export const CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxTopic = outboxTopic;

export const createCreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxProducerModuleKey,
  topic: CreatePartyRelationshipPartyRegistryRelationshipCreatedV1OutboxTopic,
});
