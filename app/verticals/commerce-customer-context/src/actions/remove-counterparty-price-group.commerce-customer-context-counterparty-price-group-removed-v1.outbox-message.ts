/* oxlint-disable github/filenames-match-regex -- Codesmith owns this action/topic filename; remove-when: Codesmith emits lint-compatible wrappers. */
import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-removed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-price-group-removed-v1';

const RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxTopic = outboxTopic;

export const createRemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey:
    RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxProducerModuleKey,
  topic: RemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxTopic,
});
