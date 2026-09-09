import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-revoked-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-revoked-v1';

export const RevokeCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationRevokedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type RevokeCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationRevokedV1OutboxPayload =
  OutboxPayload;
export const RevokeCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationRevokedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RevokeCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationRevokedV1OutboxTopic =
  outboxTopic;

export const createRevokeCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationRevokedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RevokeCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationRevokedV1OutboxProducerModuleKey,
    topic:
      RevokeCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationRevokedV1OutboxTopic,
  });
