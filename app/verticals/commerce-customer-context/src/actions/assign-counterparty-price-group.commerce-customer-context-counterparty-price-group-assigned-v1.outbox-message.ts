/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-assigned-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-assigned-v1';

const AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxTopic = outboxTopic;

export const createAssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxProducerModuleKey,
  topic: AssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxTopic,
});
