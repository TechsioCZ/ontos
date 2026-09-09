/* oxlint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this action/topic filename and local alias seam; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-archived-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-archived-v1';

export const ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxPayload =
  OutboxPayload;
export const ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxTopic =
  outboxTopic;

export const createArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxProducerModuleKey,
    topic: ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxTopic,
  });
