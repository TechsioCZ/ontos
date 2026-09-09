/* oxlint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this action/topic filename and local alias seam; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-cancelled-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-cancelled-v1';

export const RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxPayload =
  OutboxPayload;
export const RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxTopic =
  outboxTopic;

export const createRemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxProducerModuleKey,
    topic: RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxTopic,
  });
