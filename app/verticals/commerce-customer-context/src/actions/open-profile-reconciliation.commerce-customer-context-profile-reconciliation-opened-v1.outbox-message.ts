import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-profile-reconciliation-opened-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-profile-reconciliation-opened-v1';

export const OpenProfileReconciliationCommerceCustomerContextProfileReconciliationOpenedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type OpenProfileReconciliationCommerceCustomerContextProfileReconciliationOpenedV1OutboxPayload =
  OutboxPayload;
export const OpenProfileReconciliationCommerceCustomerContextProfileReconciliationOpenedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const OpenProfileReconciliationCommerceCustomerContextProfileReconciliationOpenedV1OutboxTopic =
  outboxTopic;

export const createOpenProfileReconciliationCommerceCustomerContextProfileReconciliationOpenedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      OpenProfileReconciliationCommerceCustomerContextProfileReconciliationOpenedV1OutboxProducerModuleKey,
    topic: OpenProfileReconciliationCommerceCustomerContextProfileReconciliationOpenedV1OutboxTopic,
  });
