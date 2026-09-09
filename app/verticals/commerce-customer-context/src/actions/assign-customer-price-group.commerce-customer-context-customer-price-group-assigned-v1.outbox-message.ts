/* eslint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this topic-derived filename and compatibility aliases; expires: 2027-03-01. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-assigned-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-assigned-v1';

export const AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxPayload =
  OutboxPayload;
export const AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxTopic =
  outboxTopic;

export const createAssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxProducerModuleKey,
    topic: AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxTopic,
  });
