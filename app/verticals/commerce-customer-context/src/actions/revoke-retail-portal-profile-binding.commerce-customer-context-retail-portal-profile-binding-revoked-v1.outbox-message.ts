import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-revoked-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-revoked-v1';

const RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxTopic =
  outboxTopic;

export const createRevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxProducerModuleKey,
    topic: RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxTopic,
  });
