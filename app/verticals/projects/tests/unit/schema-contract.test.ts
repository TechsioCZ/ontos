// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { getTableName, isTable } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Schema } from 'effect';
import * as schemaExports from '../../src/db/schema.ts';
import {
  PROJECTS_SCHEMA_NAME,
  PROJECTS_TABLE_INVENTORY,
  contacts,
  customers,
} from '../../src/db/schema.ts';
import type {
  ContactRecord,
  CustomerRecord,
  NewContactRecord,
  NewCustomerRecord,
} from '../../src/db/schema.ts';

const dialect = new PgDialect();
const customerConfig = getTableConfig(customers);
const contactConfig = getTableConfig(contacts);

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type _CustomerRecordKeys = Expect<
  Equal<
    keyof CustomerRecord,
    | 'archivedAt'
    | 'createdAt'
    | 'customerId'
    | 'dic'
    | 'dissolvedOn'
    | 'establishedOn'
    | 'ico'
    | 'legalFormCode'
    | 'name'
    | 'tenantId'
    | 'updatedAt'
  >
>;
type _ContactRecordKeys = Expect<
  Equal<
    keyof ContactRecord,
    | 'archivedAt'
    | 'contactId'
    | 'createdAt'
    | 'customerId'
    | 'email'
    | 'name'
    | 'phone'
    | 'tenantId'
    | 'updatedAt'
  >
>;
type _CustomerArchive = Expect<Equal<CustomerRecord['archivedAt'], Date | null>>;
type _CustomerIco = Expect<Equal<CustomerRecord['ico'], string | null>>;
type _CustomerDic = Expect<Equal<CustomerRecord['dic'], string | null>>;
type _CustomerLegalFormCode = Expect<Equal<CustomerRecord['legalFormCode'], string | null>>;
type _CustomerEstablishedOn = Expect<Equal<CustomerRecord['establishedOn'], string | null>>;
type _CustomerDissolvedOn = Expect<Equal<CustomerRecord['dissolvedOn'], string | null>>;
type _ContactArchive = Expect<Equal<ContactRecord['archivedAt'], Date | null>>;
type _NewCustomerArchive = Expect<Equal<NewCustomerRecord['archivedAt'], Date | null | undefined>>;
type _NewCustomerIco = Expect<Equal<NewCustomerRecord['ico'], string | null | undefined>>;
type _NewContactArchive = Expect<Equal<NewContactRecord['archivedAt'], Date | null | undefined>>;

const findColumn = (config: typeof customerConfig | typeof contactConfig, name: string) => {
  const column = config.columns.find((candidate) => candidate.name === name);
  assert.ok(column, `Expected ${config.name}.${name}`);
  return column;
};

const indexColumnNames = (config: typeof customerConfig | typeof contactConfig, name: string) => {
  const tableIndex = config.indexes.find((candidate) => candidate.config.name === name);
  assert.ok(tableIndex, `Expected index ${name}`);
  return tableIndex.config.columns.map((column) => ('name' in column ? column.name : false));
};

test('owns exactly Customer and Contact tables in the Projects schema', () => {
  const exportedTables = Object.values(schemaExports).filter((value): value is PgTable =>
    isTable(value),
  );
  const qualifiedNames = exportedTables
    .map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    })
    .toSorted();

  assert.equal(PROJECTS_SCHEMA_NAME, 'projects');
  assert.deepEqual(PROJECTS_TABLE_INVENTORY, ['contacts', 'customers']);
  assert.deepEqual(qualifiedNames, ['projects.contacts', 'projects.customers']);
});

test('keeps Customer business identity tenant-owned, nullable, constrained, and archivable', () => {
  assert.equal(customerConfig.schema, 'projects');
  assert.equal(customerConfig.name, 'customers');
  assert.deepEqual(
    customerConfig.columns.map((column) => column.name),
    [
      'customer_id',
      'tenant_id',
      'name',
      'ico',
      'dic',
      'legal_form_code',
      'established_on',
      'dissolved_on',
      'created_at',
      'updated_at',
      'archived_at',
    ],
  );
  for (const name of ['customer_id', 'tenant_id', 'name', 'created_at', 'updated_at']) {
    assert.equal(findColumn(customerConfig, name).notNull, true);
  }
  assert.equal(findColumn(customerConfig, 'customer_id').hasDefault, true);
  assert.equal(findColumn(customerConfig, 'created_at').hasDefault, true);
  assert.equal(findColumn(customerConfig, 'updated_at').hasDefault, true);
  for (const name of [
    'ico',
    'dic',
    'legal_form_code',
    'established_on',
    'dissolved_on',
    'archived_at',
  ]) {
    assert.equal(findColumn(customerConfig, name).notNull, false);
  }
  assert.equal(findColumn(customerConfig, 'ico').getSQLType(), 'text');
  assert.equal(findColumn(customerConfig, 'dic').getSQLType(), 'text');
  assert.equal(findColumn(customerConfig, 'legal_form_code').getSQLType(), 'text');
  assert.equal(findColumn(customerConfig, 'established_on').getSQLType(), 'date');
  assert.equal(findColumn(customerConfig, 'dissolved_on').getSQLType(), 'date');
  const tenantIdentity = customerConfig.uniqueConstraints.find(
    (candidate) => candidate.name === 'projects_customers_tenant_id_uk',
  );
  assert.ok(tenantIdentity);
  assert.deepEqual(
    tenantIdentity.columns.map((column) => column.name),
    ['tenant_id', 'customer_id'],
  );
  assert.deepEqual(indexColumnNames(customerConfig, 'projects_customers_tenant_active_idx'), [
    'tenant_id',
    'name',
  ]);
  const activeIndex = customerConfig.indexes.find(
    (candidate) => candidate.config.name === 'projects_customers_tenant_active_idx',
  );
  assert.ok(activeIndex?.config.where);
  const icoIndex = customerConfig.indexes.find(
    (candidate) => candidate.config.name === 'projects_customers_tenant_ico_uk',
  );
  assert.ok(icoIndex);
  assert.equal(icoIndex.config.unique, true);
  assert.equal(icoIndex.config.where, undefined);
  assert.deepEqual(indexColumnNames(customerConfig, 'projects_customers_tenant_ico_uk'), [
    'tenant_id',
    'ico',
  ]);

  assert.deepEqual(customerConfig.checks.map((candidate) => candidate.name).toSorted(), [
    'projects_customers_dic_ck',
    'projects_customers_ico_ck',
    'projects_customers_legal_form_code_ck',
    'projects_customers_lifecycle_dates_ck',
    'projects_customers_name_ck',
  ]);
  const checkSql = Object.fromEntries(
    customerConfig.checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  assert.match(checkSql['projects_customers_name_ck'] ?? '', /btrim/u);
  assert.match(checkSql['projects_customers_ico_ck'] ?? '', /\[0-9\]\{8\}/u);
  assert.match(checkSql['projects_customers_dic_ck'] ?? '', /between 1 and 20/u);
  assert.match(checkSql['projects_customers_legal_form_code_ck'] ?? '', /\[0-9\]\{3\}/u);
  assert.match(checkSql['projects_customers_lifecycle_dates_ck'] ?? '', />=/u);
});

test('requires Contact business fields and one restrictive same-tenant Customer parent', () => {
  assert.equal(contactConfig.schema, 'projects');
  assert.equal(contactConfig.name, 'contacts');
  assert.deepEqual(
    contactConfig.columns.map((column) => column.name),
    [
      'contact_id',
      'tenant_id',
      'customer_id',
      'name',
      'email',
      'phone',
      'created_at',
      'updated_at',
      'archived_at',
    ],
  );
  for (const name of [
    'contact_id',
    'tenant_id',
    'customer_id',
    'name',
    'email',
    'phone',
    'created_at',
    'updated_at',
  ]) {
    assert.equal(findColumn(contactConfig, name).notNull, true);
  }
  assert.equal(findColumn(contactConfig, 'archived_at').notNull, false);
  assert.deepEqual(indexColumnNames(contactConfig, 'projects_contacts_tenant_id_uk'), [
    'tenant_id',
    'contact_id',
  ]);
  assert.deepEqual(
    indexColumnNames(contactConfig, 'projects_contacts_tenant_customer_active_idx'),
    ['tenant_id', 'customer_id', 'name'],
  );

  const parentForeignKey = contactConfig.foreignKeys.find(
    (candidate) => candidate.getName() === 'projects_contacts_tenant_customer_fk',
  );
  assert.ok(parentForeignKey);
  assert.equal(getTableName(parentForeignKey.reference().foreignTable), getTableName(customers));
  assert.deepEqual(
    parentForeignKey.reference().columns.map((column) => column.name),
    ['tenant_id', 'customer_id'],
  );
  assert.deepEqual(
    parentForeignKey.reference().foreignColumns.map((column) => column.name),
    ['tenant_id', 'customer_id'],
  );
  assert.equal(parentForeignKey.onDelete, 'restrict');
  assert.deepEqual(contactConfig.checks.map((candidate) => candidate.name).toSorted(), [
    'projects_contacts_email_ck',
    'projects_contacts_name_ck',
    'projects_contacts_phone_ck',
  ]);
});

test('enables forced tenant RLS with complete CRUD policies on both tables', () => {
  for (const [config, prefix] of [
    [customerConfig, 'projects_customers_tenant'],
    [contactConfig, 'projects_contacts_tenant'],
  ] as const) {
    assert.equal(config.enableRLS, true);
    assert.deepEqual(
      config.policies.map((policy) => policy.name),
      [`${prefix}_select`, `${prefix}_insert`, `${prefix}_update`, `${prefix}_delete`],
    );
    assert.deepEqual(
      config.policies.map((policy) => policy.for),
      ['select', 'insert', 'update', 'delete'],
    );
    assert.ok(config.policies[2]?.using);
    assert.ok(config.policies[2]?.withCheck);
    for (const policy of config.policies) {
      assert.equal(policy.to, 'ontos_runtime');
    }
  }
});

test('keeps the narrow generated-migration adjustment that forces RLS', async () => {
  const migrationDirectory = new URL('../../drizzle/', import.meta.url);
  const directoryEntries = await readdir(migrationDirectory);
  const migrationFiles = directoryEntries.filter((name) => name.endsWith('.sql')).toSorted();
  assert.equal(migrationFiles.length, 1);
  const migrations = await Promise.all(
    migrationFiles.map((name) => readFile(new URL(name, migrationDirectory), 'utf-8')),
  );
  const [migration] = migrations;
  assert.ok(migration);

  assert.match(migration, /CREATE SCHEMA "projects";/u);
  assert.equal(migration.match(/CREATE TABLE "projects"\./gu)?.length, 2);
  assert.equal(
    migration.match(/ALTER TABLE "projects"\."(?:contacts|customers)" ENABLE ROW LEVEL SECURITY;/gu)
      ?.length,
    2,
  );
  assert.equal(
    migration.match(/ALTER TABLE "projects"\."(?:contacts|customers)" FORCE ROW LEVEL SECURITY;/gu)
      ?.length,
    2,
  );
  for (const column of ['ico', 'dic', 'legal_form_code', 'established_on', 'dissolved_on']) {
    assert.match(migration, new RegExp(`"${column}" (?:date|text)`, 'u'));
  }
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "projects_customers_tenant_ico_uk"[\s\S]*\("tenant_id","ico"\)/u,
  );
  assert.doesNotMatch(migration, /crm/iu);
});

test('creates the runtime role before Projects policies and refreshes grants afterward', async () => {
  const rootPackage = Schema.decodeUnknownSync(
    Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  )(JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf-8')));
  const bootstrap = await readFile(
    new URL('../../../../scripts/postgres/bootstrap-runtime-role.mts', import.meta.url),
    'utf-8',
  );

  assert.equal(
    rootPackage.scripts?.['db:migrate'],
    'pnpm --filter @app/core-runtime db:migrate && pnpm --filter @app/shell-super-app db:migrate && pnpm db:bootstrap-runtime-role && pnpm --filter @app/projects db:migrate && pnpm db:bootstrap-runtime-role',
  );
  assert.match(bootstrap, /pg_catalog\.pg_namespace where nspname = \$1/u);
  assert.match(bootstrap, /schemaExists\.rows\[0\]\?\.exists !== true/u);
});

test('keeps inferred insert and record shapes aligned at runtime', () => {
  const customerInsert = {
    archivedAt: null,
    dic: 'CZ00123456',
    dissolvedOn: null,
    establishedOn: '2020-01-02',
    ico: '00123456',
    legalFormCode: '112',
    name: 'Customer',
    tenantId: '00000000-0000-4000-8000-000000000001',
  } satisfies NewCustomerRecord;
  const contactInsert = {
    archivedAt: null,
    customerId: '00000000-0000-4000-8000-000000000002',
    email: 'contact@example.test',
    name: 'Contact',
    phone: '+420123456789',
    tenantId: customerInsert.tenantId,
  } satisfies NewContactRecord;

  assert.equal(customerInsert.archivedAt, null);
  assert.equal(contactInsert.archivedAt, null);
  assert.deepEqual(Object.keys(customerInsert).toSorted(), [
    'archivedAt',
    'dic',
    'dissolvedOn',
    'establishedOn',
    'ico',
    'legalFormCode',
    'name',
    'tenantId',
  ]);
  assert.deepEqual(Object.keys(contactInsert).toSorted(), [
    'archivedAt',
    'customerId',
    'email',
    'name',
    'phone',
    'tenantId',
  ]);
});
