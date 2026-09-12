/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-reactivated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-reactivated-v1';

const ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxTopic = outboxTopic;

export const createReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxProducerModuleKey,
  topic: ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxTopic,
});
