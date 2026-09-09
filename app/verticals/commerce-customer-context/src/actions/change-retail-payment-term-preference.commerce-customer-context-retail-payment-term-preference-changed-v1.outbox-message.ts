/* oxlint-disable github/filenames-match-regex -- Codesmith derives this filename; remove-when: Codesmith emits lint-compatible outbox filenames. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-payment-term-preference-changed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-payment-term-preference-changed-v1';

export { OutboxPayloadSchema as ChangeRetailPaymentTermPreferenceCommerceCustomerContextRetailPaymentTermPreferenceChangedV1OutboxPayloadSchema } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-payment-term-preference-changed-v1';
export type ChangeRetailPaymentTermPreferenceCommerceCustomerContextRetailPaymentTermPreferenceChangedV1OutboxPayload =
  OutboxPayload;
export const ChangeRetailPaymentTermPreferenceCommerceCustomerContextRetailPaymentTermPreferenceChangedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ChangeRetailPaymentTermPreferenceCommerceCustomerContextRetailPaymentTermPreferenceChangedV1OutboxTopic =
  outboxTopic;

export const createChangeRetailPaymentTermPreferenceCommerceCustomerContextRetailPaymentTermPreferenceChangedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ChangeRetailPaymentTermPreferenceCommerceCustomerContextRetailPaymentTermPreferenceChangedV1OutboxProducerModuleKey,
    topic:
      ChangeRetailPaymentTermPreferenceCommerceCustomerContextRetailPaymentTermPreferenceChangedV1OutboxTopic,
  });
