import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-metadata-corrected-v1';
import type { OutboxPayload } from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-metadata-corrected-v1';

export const CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxPayload =
  OutboxPayload;
export const CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxTopic =
  outboxTopic;

export const createCorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxProducerModuleKey,
    topic: CorrectPaymentTermPaymentTermCatalogPaymentTermMetadataCorrectedV1OutboxTopic,
  });
