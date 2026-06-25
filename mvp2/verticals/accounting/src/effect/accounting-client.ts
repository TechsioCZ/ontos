import {
  Effect,
  makeEffectHttpApiClient,
  runEffectRequest,
} from '@modern-js/plugin-bff/effect-client';
import {
  accountingApiContract,
  accountingEffectApi,
  accountingOperationContexts,
} from '../../shared/effect/api';
import type { OperationContext } from '../../shared/effect/api';

export { Effect, runEffectRequest };

export interface AccountingClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

interface AccountingMarker {
  readonly appId: string;
  readonly build: string;
  readonly deployProfile: string;
  readonly packageName: string;
  readonly surface: string;
  readonly version: string;
}

interface AccountingItem {
  readonly id: string;
  readonly marker: AccountingMarker;
  readonly title: string;
}

interface AccountingReadiness {
  readonly checks: {
    readonly effectBff: 'ready';
    readonly moduleFederation: 'ready';
    readonly ssr: 'ready';
    readonly translations: 'ready';
  };
  readonly marker: AccountingMarker;
  readonly status: 'ready';
  readonly versionSkew: 'none';
}

interface AccountingListResult {
  readonly items: readonly AccountingItem[];
}

interface AccountingCreateResult {
  readonly item: AccountingItem;
}

interface AccountingRequestFailed {
  readonly _tag: 'AccountingRequestFailed';
  readonly cause: unknown;
}

type AccountingListEffect = Effect.Effect<AccountingListResult, AccountingRequestFailed, never>;
type AccountingReadinessEffect = Effect.Effect<
  AccountingReadiness,
  AccountingRequestFailed,
  never
>;
type AccountingGetEffect = Effect.Effect<AccountingItem, AccountingRequestFailed, never>;
type AccountingCreateEffect = Effect.Effect<AccountingCreateResult, AccountingRequestFailed, never>;

const accountingRequestFailed = (cause: unknown): AccountingRequestFailed => ({
  _tag: 'AccountingRequestFailed',
  cause,
});

const createAccountingClient = (options: AccountingClientOptions = {}) =>
  makeEffectHttpApiClient(accountingEffectApi, {
    baseUrl: options.baseUrl ?? accountingApiContract.apiPrefix,
    requestContext: {
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.operationContext === undefined
        ? {}
        : { operationContext: options.operationContext }),
      ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
    },
  });

export const listAccounting = (
  options: AccountingClientOptions & { limit?: number } = {},
): AccountingListEffect =>
  createAccountingClient({
    ...options,
    operationContext: options.operationContext ?? accountingOperationContexts.list,
  }).pipe(
    Effect.flatMap((client) => client.accounting.list({ query: { limit: options.limit } })),
    Effect.mapError(accountingRequestFailed),
  );

export const getAccountingReadiness = (
  options: AccountingClientOptions = {},
): AccountingReadinessEffect =>
  createAccountingClient({
    ...options,
    operationContext: options.operationContext ?? accountingOperationContexts.readiness,
  }).pipe(
    Effect.flatMap((client) => client.accounting.readiness({})),
    Effect.mapError(accountingRequestFailed),
  );

export const getAccounting = (
  id: string,
  options: AccountingClientOptions = {},
): AccountingGetEffect =>
  createAccountingClient({
    ...options,
    operationContext: options.operationContext ?? accountingOperationContexts.get,
  }).pipe(
    Effect.flatMap((client) => client.accounting.get({ params: { id } })),
    Effect.mapError(accountingRequestFailed),
  );

export const createAccounting = (
  title: string,
  options: AccountingClientOptions = {},
): AccountingCreateEffect =>
  createAccountingClient({
    ...options,
    operationContext: options.operationContext ?? accountingOperationContexts.create,
  }).pipe(
    Effect.flatMap((client) => client.accounting.create({ payload: { title } })),
    Effect.mapError(accountingRequestFailed),
  );
