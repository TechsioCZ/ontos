import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-granted-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-granted-v1';

export const GrantCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessGrantedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
type GrantCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessGrantedV1OutboxPayload = OutboxPayload;
const GrantCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessGrantedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const GrantCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessGrantedV1OutboxTopic = outboxTopic;

export const createGrantCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessGrantedV1OutboxMessage = (
  payload: GrantCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessGrantedV1OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    GrantCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessGrantedV1OutboxProducerModuleKey,
  topic: GrantCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessGrantedV1OutboxTopic,
});
