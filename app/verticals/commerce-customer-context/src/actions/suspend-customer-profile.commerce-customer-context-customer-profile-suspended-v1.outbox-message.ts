import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-suspended-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-suspended-v1';

export const SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxPayload =
  OutboxPayload;
export const SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxTopic =
  outboxTopic;

export const createSuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxProducerModuleKey,
    topic: SuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxTopic,
  });
