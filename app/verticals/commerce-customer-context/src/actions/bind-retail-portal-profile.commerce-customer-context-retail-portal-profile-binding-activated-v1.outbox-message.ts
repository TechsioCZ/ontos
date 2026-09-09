import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-activated-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-activated-v1';

export const BindRetailPortalProfileCommerceCustomerContextRetailPortalProfileBindingActivatedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type BindRetailPortalProfileCommerceCustomerContextRetailPortalProfileBindingActivatedV1OutboxPayload =
  OutboxPayload;
export const BindRetailPortalProfileCommerceCustomerContextRetailPortalProfileBindingActivatedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const BindRetailPortalProfileCommerceCustomerContextRetailPortalProfileBindingActivatedV1OutboxTopic =
  outboxTopic;

export const createBindRetailPortalProfileCommerceCustomerContextRetailPortalProfileBindingActivatedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      BindRetailPortalProfileCommerceCustomerContextRetailPortalProfileBindingActivatedV1OutboxProducerModuleKey,
    topic:
      BindRetailPortalProfileCommerceCustomerContextRetailPortalProfileBindingActivatedV1OutboxTopic,
  });
