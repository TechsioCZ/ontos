/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-assigned-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-assigned-v1';

const AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxTopic = outboxTopic;

export const createAssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxProducerModuleKey,
  topic: AssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxTopic,
});
