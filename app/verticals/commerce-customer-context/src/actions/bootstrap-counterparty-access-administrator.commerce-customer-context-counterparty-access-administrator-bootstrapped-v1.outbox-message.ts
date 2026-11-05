import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-administrator-bootstrapped-v1';
import type { OutboxPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-counterparty-access-administrator-bootstrapped-v1';

export const BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxPayloadSchema =
  OutboxPayloadSchema;
type BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxPayload =
  OutboxPayload;
const BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxProducerModuleKey =
  outboxProducerModuleKey;
const BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxTopic =
  outboxTopic;

export const createBootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxMessage =
  (
    payload: BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxPayload,
  ): OutboxMessage => ({
    payloadJson: payload,
    producerModuleKey:
      BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxProducerModuleKey,
    topic:
      BootstrapCounterpartyAccessAdministratorCommerceCustomerContextCounterpartyAccessAdministratorBootstrappedV1OutboxTopic,
  });
