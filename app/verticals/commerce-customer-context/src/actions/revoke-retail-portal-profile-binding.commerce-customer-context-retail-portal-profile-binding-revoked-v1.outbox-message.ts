import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-revoked-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-revoked-v1';

export const RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxPayload =
  OutboxPayload;
export const RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxTopic =
  outboxTopic;

export const createRevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxProducerModuleKey,
    topic:
      RevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxTopic,
  });
