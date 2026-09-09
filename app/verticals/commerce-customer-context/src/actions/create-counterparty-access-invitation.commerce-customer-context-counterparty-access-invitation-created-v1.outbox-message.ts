import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-created-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-created-v1';

export const CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxPayload =
  OutboxPayload;
export const CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxTopic =
  outboxTopic;

export const createCreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxProducerModuleKey,
    topic:
      CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxTopic,
  });
