/* eslint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this topic-derived filename and compatibility aliases; expires: 2027-03-01. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-removed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-removed-v1';

export const RemoveCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupRemovedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type RemoveCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupRemovedV1OutboxPayload =
  OutboxPayload;
export const RemoveCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupRemovedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RemoveCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupRemovedV1OutboxTopic =
  outboxTopic;

export const createRemoveCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupRemovedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RemoveCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupRemovedV1OutboxProducerModuleKey,
    topic: RemoveCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupRemovedV1OutboxTopic,
  });
