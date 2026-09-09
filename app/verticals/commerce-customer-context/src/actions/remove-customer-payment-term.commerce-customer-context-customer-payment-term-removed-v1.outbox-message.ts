/* oxlint-disable github/filenames-match-regex -- Codesmith derives this filename; remove-when: Codesmith emits lint-compatible outbox filenames. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-payment-term-removed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-payment-term-removed-v1';

export { OutboxPayloadSchema as RemoveCustomerPaymentTermCommerceCustomerContextCustomerPaymentTermRemovedV1OutboxPayloadSchema } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-payment-term-removed-v1';
export type RemoveCustomerPaymentTermCommerceCustomerContextCustomerPaymentTermRemovedV1OutboxPayload =
  OutboxPayload;
export const RemoveCustomerPaymentTermCommerceCustomerContextCustomerPaymentTermRemovedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RemoveCustomerPaymentTermCommerceCustomerContextCustomerPaymentTermRemovedV1OutboxTopic =
  outboxTopic;

export const createRemoveCustomerPaymentTermCommerceCustomerContextCustomerPaymentTermRemovedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RemoveCustomerPaymentTermCommerceCustomerContextCustomerPaymentTermRemovedV1OutboxProducerModuleKey,
    topic: RemoveCustomerPaymentTermCommerceCustomerContextCustomerPaymentTermRemovedV1OutboxTopic,
  });
