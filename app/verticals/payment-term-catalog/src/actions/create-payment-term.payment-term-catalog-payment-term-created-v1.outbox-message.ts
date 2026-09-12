import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-created-v1';
import type { OutboxPayload } from '@app/payment-term-catalog/outbox/payment-term-catalog-payment-term-created-v1';

const CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxProducerModuleKey = outboxProducerModuleKey;
const CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxTopic = outboxTopic;

export const createCreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxProducerModuleKey,
  topic: CreatePaymentTermPaymentTermCatalogPaymentTermCreatedV1OutboxTopic,
});
