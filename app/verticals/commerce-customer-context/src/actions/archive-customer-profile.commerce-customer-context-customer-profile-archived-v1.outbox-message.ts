import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-archived-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-profile-archived-v1';

export const ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxPayload =
  OutboxPayload;
export const ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxTopic =
  outboxTopic;

export const createArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxProducerModuleKey,
    topic: ArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxTopic,
  });
