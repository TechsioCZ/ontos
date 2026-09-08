import { expect, it } from 'effect-rstest';

import { getTableName, isTable } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as schemaExports from '../../src/db/schema.ts';
import {
  ACTION_INVOCATION_STATUSES,
  CORE_SCHEMA_NAME,
  CORE_TABLE_INVENTORY,
  actionInvocations,
  domainEvents,
  principals,
} from '../../src/db/schema.ts';

const actionConfig = getTableConfig(actionInvocations);
const dialect = new PgDialect();
type SchemaExport = (typeof schemaExports)[keyof typeof schemaExports];
const isPgTable = (value: SchemaExport): value is Extract<SchemaExport, PgTable> => isTable(value);
const getColumn = (name: string) => {
  const column = actionConfig.columns.find((candidate) => candidate.name === name);
  if (column === undefined) {
    expect.unreachable(`Expected action_invocations.${name}`);
  }
  return column;
};
it('exports exactly the 18 Core tables in PostgreSQL schema core', () => {
  const exportedTables: PgTable[] = [];
  for (const value of Object.values(schemaExports)) {
    if (isPgTable(value)) {
      exportedTables.push(value);
    }
  }
  const qualifiedNames = exportedTables
    .map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    })
    .toSorted();
  const expectedQualifiedNames = CORE_TABLE_INVENTORY.map(
    (tableName) => `${CORE_SCHEMA_NAME}.${tableName}`,
  ).toSorted();

  expect(qualifiedNames).toEqual(expectedQualifiedNames);
  expect(new Set(qualifiedNames).size).toBe(CORE_TABLE_INVENTORY.length);
  expect(qualifiedNames.some((name) => name.startsWith('public.'))).toBe(false);
  expect(
    qualifiedNames.some((name) =>
      /^(?:auth|ticketing|properties|property|accounting)\./u.test(name),
    ),
  ).toBe(false);
});
it('supports pre-authentication Action Invocation rows and indeterminate outcomes', () => {
  expect(getColumn('principal_id').notNull).toBe(false);
  expect(getColumn('auth_binding_id').notNull).toBe(false);
  expect(getColumn('auth_context_ref').notNull).toBe(false);
  expect(getColumn('auth_method').notNull).toBe(false);
  expect(getColumn('anonymous_session_ref').notNull).toBe(false);
  expect(getColumn('correlation_id').notNull).toBe(false);

  expect(ACTION_INVOCATION_STATUSES).toEqual([
    'received',
    'rejected',
    'running',
    'succeeded',
    'failed',
    'indeterminate',
    'replayed',
  ]);

  const statusCheck = actionConfig.checks.find(
    (candidate) => candidate.name === 'core_action_invocations_status_ck',
  );
  if (statusCheck === undefined) {
    expect.unreachable('Expected value to be present');
  }
  const statusSql = dialect.sqlToQuery(statusCheck.value).sql;

  for (const status of ACTION_INVOCATION_STATUSES) {
    expect(statusSql).toMatch(new RegExp(`'${status}'`, 'u'));
  }
});
it('preserves critical Action foreign keys and unique idempotency index', () => {
  const principalForeignKey = actionConfig.foreignKeys.find((foreignKey) =>
    foreignKey.reference().columns.some((column) => column.name === 'principal_id'),
  );
  if (principalForeignKey === undefined) {
    expect.unreachable('Expected value to be present');
  }
  expect(getTableName(principalForeignKey.reference().foreignTable)).toBe(getTableName(principals));
  expect(principalForeignKey.onDelete).toBe('restrict');
  expect(principalForeignKey.reference().columns.map((column) => column.name)).toEqual([
    'tenant_id',
    'principal_id',
  ]);

  const idempotencyIndex = actionConfig.indexes.find(
    (candidate) => candidate.config.name === 'core_action_invocations_idempotency_uk',
  );
  if (idempotencyIndex === undefined) {
    expect.unreachable('Expected value to be present');
  }
  expect(idempotencyIndex.config.unique).toBe(true);
  expect(idempotencyIndex.config.where).toBeDefined();
  expect(
    idempotencyIndex.config.columns.map((column) => ('name' in column ? column.name : false)),
  ).toEqual(['tenant_id', 'action_key', 'principal_id', 'idempotency_key']);
});
it('allocates Domain Event order through a database-owned monotonic sequence', () => {
  const domainEventConfig = getTableConfig(domainEvents);
  const sequenceColumn = domainEventConfig.columns.find(
    (candidate) => candidate.name === 'tenant_sequence_no',
  );

  if (sequenceColumn === undefined) {
    expect.unreachable('Expected value to be present');
  }
  expect(sequenceColumn.notNull).toBe(true);
  expect(sequenceColumn.hasDefault).toBe(true);
  expect(sequenceColumn.getSQLType()).toBe('bigint');

  const sequenceIndex = domainEventConfig.indexes.find(
    (candidate) => candidate.config.name === 'core_domain_events_tenant_sequence_uk',
  );
  if (sequenceIndex === undefined) {
    expect.unreachable('Expected value to be present');
  }
  expect(sequenceIndex.config.unique).toBe(true);
  expect(
    sequenceIndex.config.columns.map((column) => ('name' in column ? column.name : false)),
  ).toEqual(['tenant_id', 'tenant_sequence_no']);
});
it('keeps the inferred Action status type aligned with the lifecycle union', () => {
  type ActionInsert = typeof actionInvocations.$inferInsert;
  const status: ActionInsert['status'] = 'indeterminate';

  expect(status).toBe('indeterminate');
});
