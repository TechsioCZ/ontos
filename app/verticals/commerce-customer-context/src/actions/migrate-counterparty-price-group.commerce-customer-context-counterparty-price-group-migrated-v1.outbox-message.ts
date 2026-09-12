/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-migrated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-migrated-v1';

const MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxTopic = outboxTopic;

export const createMigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxProducerModuleKey,
  topic: MigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxTopic,
});
