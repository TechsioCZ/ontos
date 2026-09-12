/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-cancelled-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-cancelled-v1';

const RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxTopic = outboxTopic;

export const createRemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxProducerModuleKey,
  topic: RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxTopic,
});
