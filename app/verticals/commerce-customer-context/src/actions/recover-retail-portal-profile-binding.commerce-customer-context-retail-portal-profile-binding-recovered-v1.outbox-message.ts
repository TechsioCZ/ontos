import type { OutboxMessage } from '@app/core-runtime';
import {
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-recovered-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-recovered-v1';

const RecoverRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRecoveredV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const RecoverRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRecoveredV1OutboxTopic =
  outboxTopic;

export const createRecoverRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRecoveredV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      RecoverRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRecoveredV1OutboxProducerModuleKey,
    topic: RecoverRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRecoveredV1OutboxTopic,
  });
