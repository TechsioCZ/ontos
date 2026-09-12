/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-created-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-created-v1';

const CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxProducerModuleKey = outboxProducerModuleKey;
const CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxTopic = outboxTopic;

export const createCreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxProducerModuleKey,
  topic: CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxTopic,
});
