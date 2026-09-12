import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-archived-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-archived-v1';

const ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxTopic = outboxTopic;

export const createArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxProducerModuleKey,
  topic: ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxTopic,
});
