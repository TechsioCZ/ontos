/* oxlint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this action/topic filename and local alias seam; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-created-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-created-v1';

export const CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxPayload =
  OutboxPayload;
export const CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxTopic =
  outboxTopic;

export const createCreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxProducerModuleKey,
  topic: CreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxTopic,
});
