/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-updated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-updated-v1';

const UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxProducerModuleKey = outboxProducerModuleKey;
const UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxTopic = outboxTopic;

export const createUpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxProducerModuleKey,
  topic: UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxTopic,
});
