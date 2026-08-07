import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { pgPolicy } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { OperationalScope } from '../operations/context.ts';
import { OperationContextUnavailable } from '../operations/errors.ts';
import type { CoreTransaction } from './types.ts';

const scopedTransaction: unique symbol = Symbol('@app/core-runtime/db/scoped-transaction');

/** Private owner-factory capability. It is never supplied to an Action or read handler. */
export interface ScopedTransactionExecutor {
  readonly [scopedTransaction]: true;
  readonly delete: CoreTransaction['delete'];
  readonly insert: CoreTransaction['insert'];
  readonly query: CoreTransaction['query'];
  readonly select: CoreTransaction['select'];
  readonly update: CoreTransaction['update'];
}

interface SettingRow extends Record<string, unknown> {
  readonly legal_entity_id: string;
  readonly tenant_id: string;
}

export const installOperationalScope = (
  transaction: CoreTransaction,
  scope: OperationalScope,
): Effect.Effect<ScopedTransactionExecutor, OperationContextUnavailable> =>
  Effect.tryPromise({
    catch: () =>
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'The database operation scope could not be installed',
      }),
    try: async () => {
      await transaction.execute(
        sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true), set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`,
      );
      const verified = await transaction.execute<SettingRow>(sql`
        select
          current_setting('ontos.tenant_id', true) as tenant_id,
          current_setting('ontos.legal_entity_id', true) as legal_entity_id
      `);
      const [setting] = verified.rows;
      if (
        setting?.tenant_id !== scope.tenantId ||
        setting.legal_entity_id !== (scope.legalEntityId ?? '')
      ) {
        throw new Error('Transaction-local operation scope verification failed');
      }
      return Object.freeze({
        [scopedTransaction]: true as const,
        delete: transaction.delete.bind(transaction),
        insert: transaction.insert.bind(transaction),
        query: transaction.query,
        select: transaction.select.bind(transaction),
        update: transaction.update.bind(transaction),
      });
    },
  });

/** Marks an owner table as RLS-governed while preserving its concrete Drizzle type. */
export const enableGovernedRls = <Table>(table: { readonly enableRLS: () => Table }): Table =>
  table.enableRLS();

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
