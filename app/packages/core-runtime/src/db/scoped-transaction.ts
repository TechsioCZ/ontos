import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgPolicy } from 'drizzle-orm/pg-core';
import { Context, DateTime, Effect, Option, Predicate } from 'effect';

import type { OperationalScope } from '../operations/context.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';
import { scopedRoutineInvokerFromTransaction } from './scoped-routine.ts';
import type { ScopedRoutineInvoker } from './scoped-routine.ts';
import type { CoreTransaction } from './types.ts';

const scopedTransaction: unique symbol = Symbol('@app/core-runtime/db/scoped-transaction');
type ScopedRoutineRawRow = Record<string, never>;
type OperationalScopeRawTransaction = Pick<CoreTransaction, 'delete' | 'execute' | 'insert' | 'select' | 'update'>;

/** Private owner-factory capability. It is never supplied to an Action or read handler. */
export interface ScopedTransactionExecutor extends ScopedRoutineInvoker {
  readonly delete: CoreTransaction['delete'];
  readonly insert: CoreTransaction['insert'];
  /** Core-installed scope snapshot; owner readers bind their predicates to this transaction. */
  readonly scope: Readonly<Pick<OperationalScope, 'tenantId' | 'legalEntityId'>>;
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
  transaction: OperationalScopeRawTransaction,
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

const installedScopeMatches = (installed: SettingRow, scope: OperationalScope) =>
  installed.tenant_id === scope.tenantId && installed.legal_entity_id === (scope.legalEntityId ?? '');

const scopedTransactionExecutor = (
  transaction: Pick<CoreTransaction, 'delete' | 'insert' | 'select' | 'update'>,
  routineInvoker: ScopedRoutineInvoker,
  scope: OperationalScope,
): ScopedTransactionExecutor =>
  Object.freeze({
    delete: transaction.delete.bind(transaction),
    insert: transaction.insert.bind(transaction),
    invoke: routineInvoker.invoke,
    scope: Object.freeze(
      scope.legalEntityId === undefined
        ? { tenantId: scope.tenantId }
        : { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId },
    ),
    [scopedTransaction]: true as const,
    select: transaction.select.bind(transaction),
    update: transaction.update.bind(transaction),
  });

export const installOperationalScopeFromTransactionService = Effect.fn('installOperationalScopeFromTransactionService')(
  function* installOperationalScopeFromTransactionServiceEffect(scope: OperationalScope) {
    const transaction = yield* OperationalScopeTransaction;
    yield* transaction.install(scope);
    const setting = yield* transaction.verify;
    if (Option.isNone(setting) || !installedScopeMatches(setting.value, scope)) {
      return yield* operationContextUnavailable();
    }
    return scopedTransactionExecutor(transaction, transaction.scopedRoutineInvoker(scope), scope);
  },
);

interface InstalledScopeRow extends SettingRow {
  readonly isolation?: string;
  readonly operation_at: unknown;
}

/**
 * Installs the operation scope and reads the transaction's trusted start time in ONE statement. `set_config` returns
 * the value it installed, so the returned row is the verification that a separate `current_setting` read gave, and
 * `transaction_timestamp()` is the same immutable start time a separate read returns: three round trips become one
 * on every governed Read transaction.
 */
export const installOperationalScopeAt = Effect.fn('installOperationalScopeAt')(
  function* installOperationalScopeAtEffect(
    transaction: OperationalScopeRawTransaction,
    scope: OperationalScope,
    lock?: { readonly acquire: SQL; readonly isolation: 'read committed' },
  ) {
    // Infrastructure locks may share scope installation, but any protected data read must use a later
    // statement: READ COMMITTED needs a new snapshot after a possible advisory-lock wait.
    const locking =
      lock === undefined
        ? sql``
        : sql`, current_setting('transaction_isolation') as isolation, case when current_setting('transaction_isolation') = ${lock.isolation} then ${lock.acquire} end as publication_lock`;
    const [installed] = yield* transaction
      .execute<InstalledScopeRow>(
        sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true) as tenant_id, set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true) as legal_entity_id, transaction_timestamp() as operation_at${locking}`,
        'objects',
      )
      .pipe(Effect.mapError(operationContextUnavailable));
    if (
      installed === undefined ||
      !installedScopeMatches(installed, scope) ||
      (lock !== undefined && installed.isolation !== lock.isolation) ||
      !Predicate.isDate(installed.operation_at) ||
      !Number.isFinite(installed.operation_at.getTime())
    ) {
      return yield* operationContextUnavailable();
    }
    const routineInvoker = scopedRoutineInvokerFromTransaction(
      (statement) => transaction.execute<ScopedRoutineRawRow>(statement, 'objects'),
      scope,
    );
    return {
      operationAt: DateTime.fromDateUnsafe(installed.operation_at),
      scoped: scopedTransactionExecutor(transaction, routineInvoker, scope),
    };
  },
);

export const installOperationalScope = (
  transaction: OperationalScopeRawTransaction,
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
