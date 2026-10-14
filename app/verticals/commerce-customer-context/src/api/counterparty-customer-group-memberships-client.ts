import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted } from 'effect';
import { CounterpartyCustomerGroupMembershipsApi } from '../../shared/apis/counterparty-customer-group-memberships.ts';
import type { CounterpartyCustomerGroupMembershipsRequest } from '../../shared/apis/counterparty-customer-group-memberships.ts';
import { operationGateway } from './action-gateway.ts';

export interface CounterpartyCustomerGroupMembershipsClientOptions {
  readonly baseUrl?: string | URL;
  readonly compositionRevision?: string;
}

type CounterpartyCustomerGroupMembershipsAuthorizedInvocation = readonly [
  credential: string,
  requestCorrelation: string,
  options?: CounterpartyCustomerGroupMembershipsClientOptions,
];

type CounterpartyCustomerGroupMembershipsOperationInvocation = readonly [
  requestCorrelation: string,
  options?: CounterpartyCustomerGroupMembershipsClientOptions,
];

const counterpartyCustomerGroupMembershipsClient = (
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: CounterpartyCustomerGroupMembershipsClientOptions,
) =>
  makeGovernedEffectBffClient(
    {
      api: CounterpartyCustomerGroupMembershipsApi,
      credential,
      defaultApiPrefix: '/commerce-customer-context-api',
      requestCorrelation,
    },
    options,
  );

export const executeCounterpartyCustomerGroupMembershipsWithAuthorization = (
  payload: CounterpartyCustomerGroupMembershipsRequest,
  ...[credential, requestCorrelation, options = {}]: CounterpartyCustomerGroupMembershipsAuthorizedInvocation
) =>
  counterpartyCustomerGroupMembershipsClient(Redacted.make(credential), requestCorrelation, options).pipe(
    Effect.flatMap((client) => client.counterpartyCustomerGroupMemberships.execute({ payload })),
  );

export const executeCounterpartyCustomerGroupMemberships = (
  payload: CounterpartyCustomerGroupMembershipsRequest,
  ...[requestCorrelation, options = {}]: CounterpartyCustomerGroupMembershipsOperationInvocation
) =>
  operationGateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
    executeCounterpartyCustomerGroupMembershipsWithAuthorization(payload, credential, requestCorrelation, {
      ...options,
      baseUrl: apiBaseUrl,
      compositionRevision,
    }),
  );
