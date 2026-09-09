/* eslint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this topic-derived filename and compatibility aliases; expires: 2027-03-01. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-assigned-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-assigned-v1';

export const AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxPayload =
  OutboxPayload;
export const AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxTopic =
  outboxTopic;

export const createAssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxProducerModuleKey,
    topic:
      AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxTopic,
  });
