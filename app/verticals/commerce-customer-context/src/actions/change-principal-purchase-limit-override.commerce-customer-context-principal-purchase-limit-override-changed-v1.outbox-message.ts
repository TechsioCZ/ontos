/* eslint-disable github/filenames-match-regex -- Codesmith composes the owning Action slug and exact topic; remove-when: Codesmith emits lint-compatible outbox filenames. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-principal-purchase-limit-override-changed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-principal-purchase-limit-override-changed-v1';

const ChangePrincipalPurchaseLimitOverrideCommerceCustomerContextPrincipalPurchaseLimitOverrideChangedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ChangePrincipalPurchaseLimitOverrideCommerceCustomerContextPrincipalPurchaseLimitOverrideChangedV1OutboxTopic =
  outboxTopic;

export const createChangePrincipalPurchaseLimitOverrideCommerceCustomerContextPrincipalPurchaseLimitOverrideChangedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ChangePrincipalPurchaseLimitOverrideCommerceCustomerContextPrincipalPurchaseLimitOverrideChangedV1OutboxProducerModuleKey,
    topic:
      ChangePrincipalPurchaseLimitOverrideCommerceCustomerContextPrincipalPurchaseLimitOverrideChangedV1OutboxTopic,
  });
