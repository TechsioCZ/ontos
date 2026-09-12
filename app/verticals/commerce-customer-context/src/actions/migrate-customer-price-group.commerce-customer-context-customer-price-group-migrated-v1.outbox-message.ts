/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-migrated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-customer-price-group-migrated-v1';

const MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxTopic = outboxTopic;

export const createMigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxProducerModuleKey,
  topic: MigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxTopic,
});
