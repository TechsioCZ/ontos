/* eslint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this topic-derived filename and compatibility aliases; expires: 2027-03-01. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-removed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-removed-v1';

export const RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxPayload =
  OutboxPayload;
export const RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxTopic =
  outboxTopic;

export const createRemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxProducerModuleKey,
    topic:
      RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxTopic,
  });
