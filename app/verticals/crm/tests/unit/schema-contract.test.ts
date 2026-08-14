// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { getTableName, isTable } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as schemaExports from '../../src/db/schema.ts';
import { CRM_SCHEMA_NAME, CRM_TABLE_INVENTORY, contacts, customers } from '../../src/db/schema.ts';
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
    'archivedAt' | 'createdAt' | 'customerId' | 'name' | 'tenantId' | 'updatedAt'
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
type _ContactArchive = Expect<Equal<ContactRecord['archivedAt'], Date | null>>;
type _NewCustomerArchive = Expect<Equal<NewCustomerRecord['archivedAt'], Date | null | undefined>>;
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

test('owns exactly Customer and Contact tables in the CRM schema', () => {
  const exportedTables = (Object.values(schemaExports) as unknown[]).filter(
    (value): value is PgTable => isTable(value),
  );
  const qualifiedNames = exportedTables
    .map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    })
    .toSorted();

  assert.equal(CRM_SCHEMA_NAME, 'crm');
  assert.deepEqual(CRM_TABLE_INVENTORY, ['contacts', 'customers']);
  assert.deepEqual(qualifiedNames, ['crm.contacts', 'crm.customers']);
});

test('keeps Customer minimal, tenant-owned, timestamped, and archivable', () => {
  assert.equal(customerConfig.schema, 'crm');
  assert.equal(customerConfig.name, 'customers');
  assert.deepEqual(
    customerConfig.columns.map((column) => column.name),
    ['customer_id', 'tenant_id', 'name', 'created_at', 'updated_at', 'archived_at'],
  );
  for (const name of ['customer_id', 'tenant_id', 'name', 'created_at', 'updated_at']) {
    assert.equal(findColumn(customerConfig, name).notNull, true);
  }
  assert.equal(findColumn(customerConfig, 'customer_id').hasDefault, true);
  assert.equal(findColumn(customerConfig, 'created_at').hasDefault, true);
  assert.equal(findColumn(customerConfig, 'updated_at').hasDefault, true);
  assert.equal(findColumn(customerConfig, 'archived_at').notNull, false);
  const tenantIdentity = customerConfig.uniqueConstraints.find(
    (candidate) => candidate.name === 'crm_customers_tenant_id_uk',
  );
  assert.ok(tenantIdentity);
  assert.deepEqual(
    tenantIdentity.columns.map((column) => column.name),
    ['tenant_id', 'customer_id'],
  );
  assert.deepEqual(indexColumnNames(customerConfig, 'crm_customers_tenant_active_idx'), [
    'tenant_id',
    'name',
  ]);
  const activeIndex = customerConfig.indexes.find(
    (candidate) => candidate.config.name === 'crm_customers_tenant_active_idx',
  );
  assert.ok(activeIndex?.config.where);
  const nameCheck = customerConfig.checks.find(
    (candidate) => candidate.name === 'crm_customers_name_ck',
  );
  assert.ok(nameCheck);
  assert.match(dialect.sqlToQuery(nameCheck.value).sql, /btrim/u);
});

test('requires Contact business fields and one restrictive same-tenant Customer parent', () => {
  assert.equal(contactConfig.schema, 'crm');
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
  assert.deepEqual(indexColumnNames(contactConfig, 'crm_contacts_tenant_id_uk'), [
    'tenant_id',
    'contact_id',
  ]);
  assert.deepEqual(indexColumnNames(contactConfig, 'crm_contacts_tenant_customer_active_idx'), [
    'tenant_id',
    'customer_id',
    'name',
  ]);

  const parentForeignKey = contactConfig.foreignKeys.find(
    (candidate) => candidate.getName() === 'crm_contacts_tenant_customer_fk',
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
    'crm_contacts_email_ck',
    'crm_contacts_name_ck',
    'crm_contacts_phone_ck',
  ]);
});

test('enables forced tenant RLS with complete CRUD policies on both tables', () => {
  for (const [config, prefix] of [
    [customerConfig, 'crm_customers_tenant'],
    [contactConfig, 'crm_contacts_tenant'],
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
  const migrationFiles = directoryEntries.filter((name) => name.endsWith('.sql'));
  assert.equal(migrationFiles.length, 1);
  const [migrationFile] = migrationFiles;
  assert.ok(migrationFile);
  const migration = await readFile(new URL(migrationFile, migrationDirectory), 'utf-8');

  assert.equal(
    migration.match(/ALTER TABLE "crm"\."(?:contacts|customers)" ENABLE ROW LEVEL SECURITY;/gu)
      ?.length,
    2,
  );
  assert.equal(
    migration.match(/ALTER TABLE "crm"\."(?:contacts|customers)" FORCE ROW LEVEL SECURITY;/gu)
      ?.length,
    2,
  );
});

test('creates the runtime role before CRM policies and refreshes grants afterward', async () => {
  const rootPackage = JSON.parse(
    await readFile(new URL('../../../../package.json', import.meta.url), 'utf-8'),
  ) as { readonly scripts?: Readonly<Record<string, string>> };
  const bootstrap = await readFile(
    new URL('../../../../scripts/postgres/bootstrap-runtime-role.mts', import.meta.url),
    'utf-8',
  );

  assert.equal(
    rootPackage.scripts?.['db:migrate'],
    'pnpm --filter @app/core-runtime db:migrate && pnpm --filter @app/shell-super-app db:migrate && pnpm db:bootstrap-runtime-role && pnpm --filter @app/crm db:migrate && pnpm db:bootstrap-runtime-role',
  );
  assert.match(bootstrap, /pg_catalog\.pg_namespace where nspname = \$1/u);
  assert.match(bootstrap, /schemaExists\.rows\[0\]\?\.exists !== true/u);
});

test('keeps inferred insert and record shapes aligned at runtime', () => {
  const customerInsert = {
    archivedAt: null,
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
  assert.deepEqual(Object.keys(customerInsert).toSorted(), ['archivedAt', 'name', 'tenantId']);
  assert.deepEqual(Object.keys(contactInsert).toSorted(), [
    'archivedAt',
    'customerId',
    'email',
    'name',
    'phone',
    'tenantId',
  ]);
});
