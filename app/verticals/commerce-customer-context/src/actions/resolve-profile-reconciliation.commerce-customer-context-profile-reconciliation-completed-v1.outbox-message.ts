import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-profile-reconciliation-completed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-profile-reconciliation-completed-v1';

export const ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxPayload =
  OutboxPayload;
export const ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxTopic =
  outboxTopic;

export const createResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxProducerModuleKey,
    topic:
      ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxTopic,
  });
