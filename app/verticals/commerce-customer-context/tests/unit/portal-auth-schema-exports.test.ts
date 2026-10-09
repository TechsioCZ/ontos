import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  COMMERCE_PORTAL_AUTH_SCHEMA_NAME,
  COMMERCE_PORTAL_AUTH_TABLES,
  account,
  commercePortalAuthDatabaseSchema,
  commercePortalAuthSchema,
  twoFactor,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';

/**
 * Drizzle Kit discovers a schema through the module's own exports, and the Better Auth adapter is
 * handed `commercePortalAuthDatabaseSchema`. The two lists are written separately, so a table that
 * reaches the adapter without reaching migration generation — or a table defined outside the schema
 * handle the portal migration journal covers — is a silent drop rather than a build failure.
 */

const identityOf = (table: PgTable): string => {
  const { name, schema } = getTableConfig(table);
  return `${schema ?? ''}.${name}`;
};

const sorted = (identities: readonly string[]) => EffectArray.sort(identities, Order.String);

it('migrates every table the Better Auth adapter is handed', () => {
  const adapterTables = Object.values(commercePortalAuthDatabaseSchema).map(identityOf);
  const migratedTables = COMMERCE_PORTAL_AUTH_TABLES.map(identityOf);
  expect(sorted(adapterTables.filter((identity) => !migratedTables.includes(identity)))).toStrictEqual([]);
  // The two Better Auth tables no Commerce module imports are the ones a cleanup would unexport
  // first, so they are named rather than left to the set comparison alone.
  expect(migratedTables).toContain(identityOf(account));
  expect(migratedTables).toContain(identityOf(twoFactor));
});

it('defines every migrated portal table in the schema handle the migration journal covers', () => {
  expect(commercePortalAuthSchema.schemaName).toBe(COMMERCE_PORTAL_AUTH_SCHEMA_NAME);
  const outsideSchema = COMMERCE_PORTAL_AUTH_TABLES.map(identityOf).filter(
    (identity) => !identity.startsWith(`${COMMERCE_PORTAL_AUTH_SCHEMA_NAME}.`),
  );
  expect(sorted(outsideSchema)).toStrictEqual([]);
});
