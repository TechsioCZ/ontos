import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-reference-reconciled-v1';
import type { OutboxPayload } from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-reference-reconciled-v1';

const ReconcilePaymentTermReferencePaymentTermCatalogPaymentTermReferenceReconciledV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ReconcilePaymentTermReferencePaymentTermCatalogPaymentTermReferenceReconciledV1OutboxTopic = outboxTopic;

export const createReconcilePaymentTermReferencePaymentTermCatalogPaymentTermReferenceReconciledV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    ReconcilePaymentTermReferencePaymentTermCatalogPaymentTermReferenceReconciledV1OutboxProducerModuleKey,
  topic: ReconcilePaymentTermReferencePaymentTermCatalogPaymentTermReferenceReconciledV1OutboxTopic,
});
