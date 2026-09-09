/* eslint-disable github/filenames-match-regex, unicorn/prefer-export-from -- Codesmith owns this topic-derived filename and compatibility aliases; expires: 2027-03-01. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-migrated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-migrated-v1';

export const MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxPayload =
  OutboxPayload;
export const MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxTopic =
  outboxTopic;

export const createMigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxProducerModuleKey,
    topic:
      MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxTopic,
  });
