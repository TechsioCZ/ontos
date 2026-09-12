import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-resent-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-resent-v1';

export const ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxPayloadSchema =
  OutboxPayloadSchema;
type ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxPayload =
  OutboxPayload;
const ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxTopic =
  outboxTopic;

export const createResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxMessage =
  (
    payload: ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxPayload,
  ): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxProducerModuleKey,
    topic: ResendCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationResentV1OutboxTopic,
  });
