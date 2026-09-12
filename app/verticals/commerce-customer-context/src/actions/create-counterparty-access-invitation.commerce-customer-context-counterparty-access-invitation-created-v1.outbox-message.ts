import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-created-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-created-v1';

export const CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
type CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxPayload =
  OutboxPayload;
const CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxTopic =
  outboxTopic;

export const createCreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxMessage =
  (
    payload: CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxPayload,
  ): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxProducerModuleKey,
    topic: CreateCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationCreatedV1OutboxTopic,
  });
