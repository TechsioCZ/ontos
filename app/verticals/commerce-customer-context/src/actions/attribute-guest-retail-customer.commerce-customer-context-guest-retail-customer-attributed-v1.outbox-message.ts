import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-guest-retail-customer-attributed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-guest-retail-customer-attributed-v1';

export const AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxPayload =
  OutboxPayload;
export const AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxTopic =
  outboxTopic;

export const createAttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxProducerModuleKey,
    topic:
      AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxTopic,
  });
