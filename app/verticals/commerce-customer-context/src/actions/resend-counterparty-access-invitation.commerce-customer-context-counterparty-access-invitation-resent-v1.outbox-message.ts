import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-resent-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-resent-v1';

export const ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxPayload =
  OutboxPayload;
export const ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxTopic =
  outboxTopic;

export const createResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxProducerModuleKey,
    topic:
      ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxTopic,
  });
