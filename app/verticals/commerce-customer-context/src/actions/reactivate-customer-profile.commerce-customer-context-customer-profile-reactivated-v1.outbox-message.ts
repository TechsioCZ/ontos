import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-reactivated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-reactivated-v1';

export const ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxPayload =
  OutboxPayload;
export const ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxTopic =
  outboxTopic;

export const createReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxProducerModuleKey,
    topic: ReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxTopic,
  });
