import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-customer-profile-created-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-customer-profile-created-v1';

const EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxTopic = outboxTopic;

export const createEnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxProducerModuleKey,
  topic: EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxTopic,
});
