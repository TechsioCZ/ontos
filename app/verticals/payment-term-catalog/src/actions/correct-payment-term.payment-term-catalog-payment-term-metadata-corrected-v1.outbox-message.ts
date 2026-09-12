import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-metadata-corrected-v1';
import type { OutboxPayload } from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-metadata-corrected-v1';

const CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxTopic = outboxTopic;

export const createCorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxProducerModuleKey,
  topic: CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxTopic,
});
