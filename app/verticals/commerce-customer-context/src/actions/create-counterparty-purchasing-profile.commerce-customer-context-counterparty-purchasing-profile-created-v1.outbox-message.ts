import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-purchasing-profile-created-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-purchasing-profile-created-v1';

const CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxTopic =
  outboxTopic;

export const createCreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxProducerModuleKey,
    topic: CreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxTopic,
  });
