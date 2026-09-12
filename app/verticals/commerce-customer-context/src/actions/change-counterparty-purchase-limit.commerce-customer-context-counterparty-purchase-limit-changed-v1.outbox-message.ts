/* eslint-disable github/filenames-match-regex -- Codesmith composes the owning Action slug and exact topic; remove-when: Codesmith emits lint-compatible outbox filenames. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-purchase-limit-changed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-purchase-limit-changed-v1';

const ChangeCounterpartyPurchaseLimitCommerceCustomerContextCounterpartyPurchaseLimitChangedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ChangeCounterpartyPurchaseLimitCommerceCustomerContextCounterpartyPurchaseLimitChangedV1OutboxTopic = outboxTopic;

export const createChangeCounterpartyPurchaseLimitCommerceCustomerContextCounterpartyPurchaseLimitChangedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ChangeCounterpartyPurchaseLimitCommerceCustomerContextCounterpartyPurchaseLimitChangedV1OutboxProducerModuleKey,
    topic: ChangeCounterpartyPurchaseLimitCommerceCustomerContextCounterpartyPurchaseLimitChangedV1OutboxTopic,
  });
