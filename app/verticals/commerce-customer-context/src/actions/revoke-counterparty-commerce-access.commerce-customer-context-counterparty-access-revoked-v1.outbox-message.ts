import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-revoked-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-revoked-v1';

export const RevokeCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessRevokedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type RevokeCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessRevokedV1OutboxPayload =
  OutboxPayload;
export const RevokeCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessRevokedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RevokeCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessRevokedV1OutboxTopic =
  outboxTopic;

export const createRevokeCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessRevokedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RevokeCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessRevokedV1OutboxProducerModuleKey,
    topic:
      RevokeCounterpartyCommerceAccessCommerceCustomerContextCounterpartyAccessRevokedV1OutboxTopic,
  });
