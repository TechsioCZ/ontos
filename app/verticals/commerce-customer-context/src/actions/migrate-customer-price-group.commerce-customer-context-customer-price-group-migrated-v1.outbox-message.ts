/* eslint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this topic-derived filename and compatibility aliases; expires: 2027-03-01. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-migrated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-migrated-v1';

export const MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxPayload =
  OutboxPayload;
export const MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxTopic =
  outboxTopic;

export const createMigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxProducerModuleKey,
    topic: MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxTopic,
  });
