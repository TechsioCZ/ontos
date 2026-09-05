// @effect-diagnostics asyncFunction:off
import { sql } from 'drizzle-orm';
import { Cause, Effect } from 'effect';
import { pgPolicy } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { OperationalScope } from '../operations/context.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';
import type { CoreTransaction } from './types.ts';

const scopedTransaction: unique symbol = Symbol('@app/core-runtime/db/scoped-transaction');

/** Private owner-factory capability. It is never supplied to an Action or read handler. */
export interface ScopedTransactionExecutor {
  readonly delete: CoreTransaction['delete'];
  readonly insert: CoreTransaction['insert'];
  readonly [scopedTransaction]: true;
  readonly select: CoreTransaction['select'];
  readonly update: CoreTransaction['update'];
}

interface SettingRow extends Record<string, unknown> {
  readonly legal_entity_id: string;
  readonly tenant_id: string;
}

export interface OperationalScopeTransactionService {
  readonly delete: CoreTransaction['delete'];
  readonly insert: CoreTransaction['insert'];
  readonly install: (scope: OperationalScope) => Promise<void>;
  readonly select: CoreTransaction['select'];
  readonly update: CoreTransaction['update'];
  readonly verify: () => Promise<SettingRow | undefined>;
}

/** Internal diagnostics bridge; the original failure never enters the wire contract. */
export const getOperationContextUnavailableCause = (
  failure: OperationContextUnavailable,
): Cause.Cause<never> | undefined => failure.diagnosticCause;

const operationalScopeTransactionFromCoreTransaction = (
  transaction: CoreTransaction,
): OperationalScopeTransactionService => ({
  delete: transaction.delete.bind(transaction),
  insert: transaction.insert.bind(transaction),
  install: async (scope) => {
    await transaction.execute(
      sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true), set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`,
    );
  },
  select: transaction.select.bind(transaction),
  update: transaction.update.bind(transaction),
  verify: async () => {
    const verified = await transaction.execute<SettingRow>(sql`
      select
        current_setting('ontos.tenant_id', true) as tenant_id,
        current_setting('ontos.legal_entity_id', true) as legal_entity_id
    `);
    return verified.rows[0];
  },
});

const installOperationalScopeStep = (
  transaction: OperationalScopeTransactionService,
  scope: OperationalScope,
): Effect.Effect<void, OperationContextUnavailable> =>
  Effect.tryPromise({
    catch: (cause) =>
      OperationContextUnavailable.fromCause(
        'The database operation scope could not be installed',
        cause,
      ),
    try: () => transaction.install(scope),
  });

const verifyOperationalScopeStep = (
  transaction: OperationalScopeTransactionService,
): Effect.Effect<SettingRow | undefined, OperationContextUnavailable> =>
  Effect.tryPromise({
    catch: (cause) =>
      OperationContextUnavailable.fromCause(
        'The database operation scope could not be verified',
        cause,
      ),
    try: () => transaction.verify(),
  });

const validateOperationalScopeStep = (
  setting: SettingRow | undefined,
  scope: OperationalScope,
): Effect.Effect<void, OperationContextUnavailable> =>
  setting?.tenant_id === scope.tenantId && setting.legal_entity_id === (scope.legalEntityId ?? '')
    ? Effect.void
    : Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'The database operation scope does not match the requested scope',
        }),
      );

export const installOperationalScopeFromTransactionService = (
  transaction: OperationalScopeTransactionService,
  scope: OperationalScope,
): Effect.Effect<ScopedTransactionExecutor, OperationContextUnavailable> =>
  Effect.gen(function* installOperationalScopeEffect() {
    yield* installOperationalScopeStep(transaction, scope);
    const setting = yield* verifyOperationalScopeStep(transaction);
    yield* validateOperationalScopeStep(setting, scope);
    return Object.freeze({
      delete: transaction.delete.bind(transaction),
      insert: transaction.insert.bind(transaction),
      [scopedTransaction]: true as const,
      select: transaction.select.bind(transaction),
      update: transaction.update.bind(transaction),
    });
  });

export const installOperationalScope = (
  transaction: CoreTransaction,
  scope: OperationalScope,
): Effect.Effect<ScopedTransactionExecutor, OperationContextUnavailable> =>
  installOperationalScopeFromTransactionService(
    operationalScopeTransactionFromCoreTransaction(transaction),
    scope,
  );

export const tenantRlsPolicies = (prefix: string, tenantColumn: AnyPgColumn) => {
  const predicate = sql`${tenantColumn} = nullif(current_setting('ontos.tenant_id', true), '')::uuid`;
  return [
    pgPolicy(`${prefix}_select`, { for: 'select', to: 'ontos_runtime', using: predicate }),
    pgPolicy(`${prefix}_insert`, { for: 'insert', to: 'ontos_runtime', withCheck: predicate }),
    pgPolicy(`${prefix}_update`, {
      for: 'update',
      to: 'ontos_runtime',
      using: predicate,
      withCheck: predicate,
    }),
    pgPolicy(`${prefix}_delete`, { for: 'delete', to: 'ontos_runtime', using: predicate }),
  ] as const;
};

export const tenantLegalEntityRlsPolicies = (
  prefix: string,
  tenantColumn: AnyPgColumn,
  legalEntityColumn: AnyPgColumn,
) => {
  const predicate = sql`${tenantColumn} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${legalEntityColumn} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  return [
    pgPolicy(`${prefix}_select`, { for: 'select', to: 'ontos_runtime', using: predicate }),
    pgPolicy(`${prefix}_insert`, { for: 'insert', to: 'ontos_runtime', withCheck: predicate }),
    pgPolicy(`${prefix}_update`, {
      for: 'update',
      to: 'ontos_runtime',
      using: predicate,
      withCheck: predicate,
    }),
    pgPolicy(`${prefix}_delete`, { for: 'delete', to: 'ontos_runtime', using: predicate }),
  ] as const;
};
