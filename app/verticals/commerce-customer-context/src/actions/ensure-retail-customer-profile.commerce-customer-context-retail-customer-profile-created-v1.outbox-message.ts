import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-customer-profile-created-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-customer-profile-created-v1';

export const EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxPayload =
  OutboxPayload;
export const EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxTopic =
  outboxTopic;

export const createEnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxProducerModuleKey,
    topic:
      EnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxTopic,
  });
