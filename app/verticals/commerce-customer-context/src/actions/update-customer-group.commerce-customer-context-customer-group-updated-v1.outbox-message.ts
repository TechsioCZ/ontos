/* oxlint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this action/topic filename and local alias seam; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-updated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-updated-v1';

export const UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxPayload =
  OutboxPayload;
export const UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxTopic =
  outboxTopic;

export const createUpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxProducerModuleKey,
  topic: UpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxTopic,
});
