import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-purchasing-profile-created-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-purchasing-profile-created-v1';

export const CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxPayload =
  OutboxPayload;
export const CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxTopic =
  outboxTopic;

export const createCreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxProducerModuleKey,
    topic:
      CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxTopic,
  });
