import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-reactivated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-reactivated-v1';

const ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxTopic = outboxTopic;

export const createReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxProducerModuleKey,
  topic: ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxTopic,
});
