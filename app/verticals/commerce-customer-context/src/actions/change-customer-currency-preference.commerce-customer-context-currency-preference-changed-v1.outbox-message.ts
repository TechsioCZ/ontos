/* eslint-disable github/filenames-match-regex -- Codesmith derives this filename from immutable Action and topic identities. expires: 2027-09-09. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-currency-preference-changed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-currency-preference-changed-v1';

export { OutboxPayloadSchema as ChangeCustomerCurrencyPreferenceCommerceCustomerContextCurrencyPreferenceChangedV1OutboxPayloadSchema } from '@app/commerce-customer-context/outbox/commerce-customer-context-currency-preference-changed-v1';
export type { OutboxPayload as ChangeCustomerCurrencyPreferenceCommerceCustomerContextCurrencyPreferenceChangedV1OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-currency-preference-changed-v1';
export const ChangeCustomerCurrencyPreferenceCommerceCustomerContextCurrencyPreferenceChangedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ChangeCustomerCurrencyPreferenceCommerceCustomerContextCurrencyPreferenceChangedV1OutboxTopic =
  outboxTopic;

export const createChangeCustomerCurrencyPreferenceCommerceCustomerContextCurrencyPreferenceChangedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ChangeCustomerCurrencyPreferenceCommerceCustomerContextCurrencyPreferenceChangedV1OutboxProducerModuleKey,
    topic:
      ChangeCustomerCurrencyPreferenceCommerceCustomerContextCurrencyPreferenceChangedV1OutboxTopic,
  });
