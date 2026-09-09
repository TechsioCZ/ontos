import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-retired-v1';
import type { OutboxPayload } from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-retired-v1';

export const RetirePaymentTermPaymentTermCatalogPaymentTermRetiredV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type RetirePaymentTermPaymentTermCatalogPaymentTermRetiredV1OutboxPayload = OutboxPayload;
export const RetirePaymentTermPaymentTermCatalogPaymentTermRetiredV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RetirePaymentTermPaymentTermCatalogPaymentTermRetiredV1OutboxTopic = outboxTopic;

export const createRetirePaymentTermPaymentTermCatalogPaymentTermRetiredV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: RetirePaymentTermPaymentTermCatalogPaymentTermRetiredV1OutboxProducerModuleKey,
  topic: RetirePaymentTermPaymentTermCatalogPaymentTermRetiredV1OutboxTopic,
});
