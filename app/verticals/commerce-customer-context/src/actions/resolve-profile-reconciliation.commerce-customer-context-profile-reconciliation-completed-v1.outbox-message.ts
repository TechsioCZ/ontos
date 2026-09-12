import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-profile-reconciliation-completed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-profile-reconciliation-completed-v1';

const ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxTopic = outboxTopic;

export const createResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxProducerModuleKey,
  topic: ResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxTopic,
});
