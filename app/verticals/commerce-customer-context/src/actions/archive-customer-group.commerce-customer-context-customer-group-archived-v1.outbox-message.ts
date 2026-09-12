/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-archived-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-group-archived-v1';

const ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxTopic = outboxTopic;

export const createArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxProducerModuleKey,
  topic: ArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxTopic,
});
