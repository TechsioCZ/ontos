import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-suspended-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-suspended-v1';

const SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxTopic = outboxTopic;

export const createSuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxProducerModuleKey,
  topic: SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxTopic,
});
