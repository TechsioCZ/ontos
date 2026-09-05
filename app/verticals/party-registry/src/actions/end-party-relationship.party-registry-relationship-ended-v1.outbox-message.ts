/* eslint-disable unicorn/prefer-export-from -- Generated action aliases intentionally bind stable action-specific names. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/party-registry/outbox/party-registry-relationship-ended-v1';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-relationship-ended-v1';

export const EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxPayload = OutboxPayload;
export const EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxTopic = outboxTopic;

export const createEndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxProducerModuleKey,
  topic: EndPartyRelationshipPartyRegistryRelationshipEndedV1OutboxTopic,
});
