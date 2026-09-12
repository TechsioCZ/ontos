/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-assigned-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-assigned-v1';

const AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxTopic = outboxTopic;

export const createAssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxProducerModuleKey,
  topic: AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxTopic,
});
