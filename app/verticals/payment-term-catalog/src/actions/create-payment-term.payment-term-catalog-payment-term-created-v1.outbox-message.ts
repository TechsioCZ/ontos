import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-created-v1';
import type { OutboxPayload } from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-created-v1';

export const CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxPayload = OutboxPayload;
export const CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxTopic = outboxTopic;

export const createCreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxProducerModuleKey,
  topic: CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxTopic,
});
