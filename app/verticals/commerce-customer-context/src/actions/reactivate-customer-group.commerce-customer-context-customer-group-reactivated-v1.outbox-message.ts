/* oxlint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this action/topic filename and local alias seam; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-reactivated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-reactivated-v1';

export const ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxPayload =
  OutboxPayload;
export const ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxTopic =
  outboxTopic;

export const createReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxProducerModuleKey,
    topic: ReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxTopic,
  });
