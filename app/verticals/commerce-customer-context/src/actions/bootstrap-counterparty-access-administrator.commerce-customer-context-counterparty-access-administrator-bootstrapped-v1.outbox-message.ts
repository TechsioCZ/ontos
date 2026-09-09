import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-administrator-bootstrapped-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-administrator-bootstrapped-v1';

export const BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
export type BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxPayload =
  OutboxPayload;
export const BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
export const BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxTopic =
  outboxTopic;

export const createBootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxMessage =
  (payload: OutboxPayload): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxProducerModuleKey,
    topic:
      BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxTopic,
  });
