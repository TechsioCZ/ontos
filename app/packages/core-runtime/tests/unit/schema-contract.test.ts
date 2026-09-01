import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableName, isTable } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
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

const getColumn = (name: string) => {
  const column = actionConfig.columns.find((candidate) => candidate.name === name);
  assert.ok(column, `Expected action_invocations.${name}`);
  return column;
};

test('exports exactly the 18 Core tables in PostgreSQL schema core', () => {
  const exportedTables = Object.values(schemaExports).filter(isTable);
  const qualifiedNames = exportedTables
    .map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    })
    .toSorted();
  const expectedQualifiedNames = CORE_TABLE_INVENTORY.map(
    (tableName) => `${CORE_SCHEMA_NAME}.${tableName}`,
  ).toSorted();

  assert.deepEqual(qualifiedNames, expectedQualifiedNames);
  assert.equal(new Set(qualifiedNames).size, 18);
  assert.equal(
    qualifiedNames.some((name) => name.startsWith('public.')),
    false,
  );
  assert.equal(
    qualifiedNames.some((name) =>
      /^(?:auth|ticketing|properties|property|accounting)\./u.test(name),
    ),
    false,
  );
});

test('supports pre-authentication Action Invocation rows and indeterminate outcomes', () => {
  assert.equal(getColumn('principal_id').notNull, false);
  assert.equal(getColumn('auth_binding_id').notNull, false);
  assert.equal(getColumn('auth_context_ref').notNull, false);
  assert.equal(getColumn('auth_method').notNull, false);
  assert.equal(getColumn('anonymous_session_ref').notNull, false);
  assert.equal(getColumn('correlation_id').notNull, false);

  assert.deepEqual(ACTION_INVOCATION_STATUSES, [
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
  assert.ok(statusCheck);
  const statusSql = dialect.sqlToQuery(statusCheck.value).sql;

  for (const status of ACTION_INVOCATION_STATUSES) {
    assert.match(statusSql, new RegExp(`'${status}'`, 'u'));
  }
});

test('preserves critical Action foreign keys and unique idempotency index', () => {
  const principalForeignKey = actionConfig.foreignKeys.find((foreignKey) =>
    foreignKey.reference().columns.some((column) => column.name === 'principal_id'),
  );
  assert.ok(principalForeignKey);
  assert.equal(
    getTableName(principalForeignKey.reference().foreignTable),
    getTableName(principals),
  );
  assert.equal(principalForeignKey.onDelete, 'restrict');
  assert.deepEqual(
    principalForeignKey.reference().columns.map((column) => column.name),
    ['tenant_id', 'principal_id'],
  );

  const idempotencyIndex = actionConfig.indexes.find(
    (candidate) => candidate.config.name === 'core_action_invocations_idempotency_uk',
  );
  assert.ok(idempotencyIndex);
  assert.equal(idempotencyIndex.config.unique, true);
  assert.ok(idempotencyIndex.config.where);
  assert.deepEqual(
    idempotencyIndex.config.columns.map((column) => 'name' in column && column.name),
    ['tenant_id', 'action_key', 'principal_id', 'idempotency_key'],
  );
});

test('allocates Domain Event order through a database-owned monotonic sequence', () => {
  const domainEventConfig = getTableConfig(domainEvents);
  const sequenceColumn = domainEventConfig.columns.find(
    (candidate) => candidate.name === 'tenant_sequence_no',
  );

  assert.ok(sequenceColumn);
  assert.equal(sequenceColumn.notNull, true);
  assert.equal(sequenceColumn.hasDefault, true);
  assert.equal(sequenceColumn.dataType, 'bigint');

  const sequenceIndex = domainEventConfig.indexes.find(
    (candidate) => candidate.config.name === 'core_domain_events_tenant_sequence_uk',
  );
  assert.ok(sequenceIndex);
  assert.equal(sequenceIndex.config.unique, true);
  assert.deepEqual(
    sequenceIndex.config.columns.map((column) => 'name' in column && column.name),
    ['tenant_id', 'tenant_sequence_no'],
  );
});

test('keeps the inferred Action status type aligned with the lifecycle union', () => {
  type ActionInsert = typeof actionInvocations.$inferInsert;
  const status: ActionInsert['status'] = 'indeterminate';

  assert.equal(status, 'indeterminate');
});
