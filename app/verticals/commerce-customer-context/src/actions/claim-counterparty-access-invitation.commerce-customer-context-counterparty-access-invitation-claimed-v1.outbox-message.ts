import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-claimed-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-invitation-claimed-v1';

export const ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
type ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxPayload =
  OutboxPayload;
const ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxTopic =
  outboxTopic;

export const createClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxMessage =
  (
    payload: ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxPayload,
  ): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxProducerModuleKey,
    topic: ClaimCounterpartyAccessInvitationCommerceCustomerContextCounterpartyAccessInvitationClaimedV1OutboxTopic,
  });
