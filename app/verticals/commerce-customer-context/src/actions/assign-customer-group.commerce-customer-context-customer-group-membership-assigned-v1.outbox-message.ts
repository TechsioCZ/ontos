/* oxlint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this action/topic filename and local alias seam; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-assigned-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-assigned-v1';

export const AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxPayload =
  OutboxPayload;
export const AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxTopic =
  outboxTopic;

export const createAssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxProducerModuleKey,
    topic: AssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxTopic,
  });
