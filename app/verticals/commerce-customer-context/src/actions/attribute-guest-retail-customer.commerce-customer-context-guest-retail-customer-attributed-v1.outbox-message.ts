import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-guest-retail-customer-attributed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-guest-retail-customer-attributed-v1';

const AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxTopic = outboxTopic;

export const createAttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxProducerModuleKey,
  topic: AttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxTopic,
});
