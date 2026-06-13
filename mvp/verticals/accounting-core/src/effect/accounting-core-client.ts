import {
  Effect,
  makeEffectHttpApiClient,
  runEffectRequest,
} from '@modern-js/plugin-bff/effect-client';
import {
  accountingCoreApiContract,
  accountingCoreEffectApi,
  accountingCoreOperationContexts,
} from '../../shared/effect/api';
import type { OperationContext } from '../../shared/effect/api';

export { Effect, runEffectRequest };

export interface AccountingCoreClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

export const createAccountingCoreClient = (options: AccountingCoreClientOptions = {}) =>
  makeEffectHttpApiClient(accountingCoreEffectApi, {
    baseUrl: options.baseUrl ?? accountingCoreApiContract.apiPrefix,
  });

export const listAccountingCore = (
  options: AccountingCoreClientOptions & { limit?: number } = {},
) =>
  createAccountingCoreClient({
    ...options,
    operationContext: options.operationContext ?? accountingCoreOperationContexts.list,
  }).pipe(
    Effect.flatMap((client) => client.accountingCore.list({ query: { limit: options.limit } })),
  );

export const getAccountingCoreReadiness = (options: AccountingCoreClientOptions = {}) =>
  createAccountingCoreClient({
    ...options,
    operationContext: options.operationContext ?? accountingCoreOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.accountingCore.readiness({})));

export const getAccountingCore = (id: string, options: AccountingCoreClientOptions = {}) =>
  createAccountingCoreClient({
    ...options,
    operationContext: options.operationContext ?? accountingCoreOperationContexts.get,
  }).pipe(Effect.flatMap((client) => client.accountingCore.get({ params: { id } })));

export const createAccountingCore = (title: string, options: AccountingCoreClientOptions = {}) =>
  createAccountingCoreClient({
    ...options,
    operationContext: options.operationContext ?? accountingCoreOperationContexts.create,
  }).pipe(Effect.flatMap((client) => client.accountingCore.create({ payload: { title } })));
