import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-claimed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-claimed-v1';

export const ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxPayload =
  OutboxPayload;
export const ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxTopic =
  outboxTopic;

export const createClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxProducerModuleKey,
    topic:
      ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxTopic,
  });
