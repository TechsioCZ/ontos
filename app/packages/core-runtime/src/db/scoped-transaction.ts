import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgPolicy } from 'drizzle-orm/pg-core';
import { Context, Effect, Option } from 'effect';

import type { OperationalScope } from '../operations/context.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';
import { scopedRoutineInvokerFromTransaction } from './scoped-routine.ts';
import type { ScopedRoutineInvoker } from './scoped-routine.ts';
import type { CoreTransaction } from './types.ts';

const scopedTransaction: unique symbol = Symbol('@app/core-runtime/db/scoped-transaction');
type ScopedRoutineRawRow = Record<string, never>;

/** Private owner-factory capability. It is never supplied to an Action or read handler. */
export interface ScopedTransactionExecutor extends ScopedRoutineInvoker {
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
  readonly install: (scope: OperationalScope) => Effect.Effect<void, OperationContextUnavailable>;
  readonly scopedRoutineInvoker: (scope: OperationalScope) => ScopedRoutineInvoker;
  readonly select: CoreTransaction['select'];
  readonly update: CoreTransaction['update'];
  readonly verify: Effect.Effect<Option.Option<SettingRow>, OperationContextUnavailable>;
}

export class OperationalScopeTransaction extends Context.Service<
  OperationalScopeTransaction,
  OperationalScopeTransactionService
>()('@app/core-runtime/db/scoped-transaction/OperationalScopeTransaction') {}

const operationContextUnavailable = (cause?: unknown) => {
  const failure = new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'The database operation scope could not be installed',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};

const operationalScopeTransactionFromCoreTransaction = (
  transaction: CoreTransaction,
): OperationalScopeTransactionService => ({
  delete: transaction.delete.bind(transaction),
  insert: transaction.insert.bind(transaction),
  install: (scope) =>
    transaction
      .execute(
        sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true), set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`,
        'objects',
      )
      .pipe(Effect.mapError(operationContextUnavailable), Effect.asVoid),
  scopedRoutineInvoker: (scope) =>
    scopedRoutineInvokerFromTransaction(
      (statement) => transaction.execute<ScopedRoutineRawRow>(statement, 'objects'),
      scope,
    ),
  select: transaction.select.bind(transaction),
  update: transaction.update.bind(transaction),
  verify: transaction
    .execute<SettingRow>(
      sql`
      select
        current_setting('ontos.tenant_id', true) as tenant_id,
        current_setting('ontos.legal_entity_id', true) as legal_entity_id
    `,
      'objects',
    )
    .pipe(
      Effect.mapError(operationContextUnavailable),
      Effect.map((verified) => Option.fromUndefinedOr(verified[0])),
    ),
});

export const installOperationalScopeFromTransactionService = Effect.fn('installOperationalScopeFromTransactionService')(
  function* installOperationalScopeFromTransactionServiceEffect(scope: OperationalScope) {
    const transaction = yield* OperationalScopeTransaction;
    yield* transaction.install(scope);
    const setting = yield* transaction.verify;
    if (
      Option.isNone(setting) ||
      setting.value.tenant_id !== scope.tenantId ||
      setting.value.legal_entity_id !== (scope.legalEntityId ?? '')
    ) {
      return yield* operationContextUnavailable();
    }
    const routineInvoker = transaction.scopedRoutineInvoker(scope);
    return Object.freeze({
      delete: transaction.delete.bind(transaction),
      insert: transaction.insert.bind(transaction),
      invoke: routineInvoker.invoke,
      [scopedTransaction]: true as const,
      select: transaction.select.bind(transaction),
      update: transaction.update.bind(transaction),
    });
  },
);

export const installOperationalScope = (
  transaction: CoreTransaction,
  scope: OperationalScope,
): Effect.Effect<ScopedTransactionExecutor, OperationContextUnavailable> =>
  installOperationalScopeFromTransactionService(scope).pipe(
    Effect.updateContext((context: Context.Context<never>) =>
      Context.add(context, OperationalScopeTransaction, operationalScopeTransactionFromCoreTransaction(transaction)),
    ),
  );

const operationalRlsPolicies = (prefix: string, predicate: SQL) =>
  [
    pgPolicy(`${prefix}_select`, {
      for: 'select',
      to: 'ontos_runtime',
      using: predicate,
    }),
    pgPolicy(`${prefix}_insert`, {
      for: 'insert',
      to: 'ontos_runtime',
      withCheck: predicate,
    }),
    pgPolicy(`${prefix}_update`, {
      for: 'update',
      to: 'ontos_runtime',
      using: predicate,
      withCheck: predicate,
    }),
    pgPolicy(`${prefix}_delete`, {
      for: 'delete',
      to: 'ontos_runtime',
      using: predicate,
    }),
  ] as const;

export const tenantRlsPolicies = (prefix: string, tenantColumn: AnyPgColumn) => {
  const predicate = sql`${tenantColumn} = nullif(current_setting('ontos.tenant_id', true), '')::uuid`;
  return operationalRlsPolicies(prefix, predicate);
};

export const tenantLegalEntityRlsPolicies = (
  prefix: string,
  tenantColumn: AnyPgColumn,
  legalEntityColumn: AnyPgColumn,
) => {
  const predicate = sql`${tenantColumn} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${legalEntityColumn} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  return operationalRlsPolicies(prefix, predicate);
};
