/* oxlint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this action/topic filename and local alias seam; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-ended-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-membership-ended-v1';

export const RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipEndedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipEndedV1OutboxPayload =
  OutboxPayload;
export const RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipEndedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipEndedV1OutboxTopic =
  outboxTopic;

export const createRemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipEndedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipEndedV1OutboxProducerModuleKey,
    topic: RemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipEndedV1OutboxTopic,
  });
