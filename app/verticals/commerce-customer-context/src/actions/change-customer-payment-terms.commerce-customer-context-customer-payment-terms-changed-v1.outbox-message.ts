/* oxlint-disable github/filenames-match-regex -- Codesmith derives this filename; remove-when: Codesmith emits lint-compatible outbox filenames. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-payment-terms-changed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-payment-terms-changed-v1';

export { OutboxPayloadSchema as ChangeCustomerPaymentTermsCommerceCustomerContextCustomerPaymentTermsChangedV1OutboxPayloadSchema } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-payment-terms-changed-v1';
export type ChangeCustomerPaymentTermsCommerceCustomerContextCustomerPaymentTermsChangedV1OutboxPayload =
  OutboxPayload;
export const ChangeCustomerPaymentTermsCommerceCustomerContextCustomerPaymentTermsChangedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ChangeCustomerPaymentTermsCommerceCustomerContextCustomerPaymentTermsChangedV1OutboxTopic =
  outboxTopic;

export const createChangeCustomerPaymentTermsCommerceCustomerContextCustomerPaymentTermsChangedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ChangeCustomerPaymentTermsCommerceCustomerContextCustomerPaymentTermsChangedV1OutboxProducerModuleKey,
    topic:
      ChangeCustomerPaymentTermsCommerceCustomerContextCustomerPaymentTermsChangedV1OutboxTopic,
  });
