/* eslint-disable unicorn/no-await-expression-member -- Assertions read the exact Effect result inline. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off processEnv:off
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { makeLegalEntityContext } from '../../src/auth/legal-entity-context.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { coreDatabaseSchema, legalEntities, tenants } from '../../src/db/schema.ts';

const tenantOne = '11000000-0000-4000-8000-000000000001';
const tenantTwo = '11000000-0000-4000-8000-000000000002';
const activeOne = '21000000-0000-4000-8000-000000000001';
const activeTwo = '21000000-0000-4000-8000-000000000002';
const suspended = '21000000-0000-4000-8000-000000000003';
const foreign = '21000000-0000-4000-8000-000000000004';

void test('lists and validates only active legal entities inside the exact tenant', async () => {
  const configuration = await Effect.runPromise(loadDatabaseConfig());
  const pool = new Pool({ connectionString: configuration.connectionString });
  const database = drizzle({ client: pool, schema: coreDatabaseSchema });
  const context = makeLegalEntityContext({ executor: database });

  const cleanup = async () => {
    await database.delete(legalEntities).where(eq(legalEntities.tenantId, tenantOne));
    await database.delete(legalEntities).where(eq(legalEntities.tenantId, tenantTwo));
    await database.delete(tenants).where(eq(tenants.tenantId, tenantOne));
    await database.delete(tenants).where(eq(tenants.tenantId, tenantTwo));
  };

  try {
    await cleanup();
    await database.insert(tenants).values([
      {
        defaultLocale: 'en',
        name: 'Legal context tenant one',
        slug: 'legal-context-tenant-one',
        status: 'active',
        tenantId: tenantOne,
      },
      {
        defaultLocale: 'en',
        name: 'Legal context tenant two',
        slug: 'legal-context-tenant-two',
        status: 'active',
        tenantId: tenantTwo,
      },
    ]);
    await database.insert(legalEntities).values([
      {
        legalEntityId: activeOne,
        legalName: 'Zeta entity',
        registrationCountry: 'CZ',
        registrationNumber: 'LEGAL-CONTEXT-1',
        status: 'active',
        tenantId: tenantOne,
      },
      {
        legalEntityId: activeTwo,
        legalName: 'Alpha entity',
        registrationCountry: 'CZ',
        registrationNumber: 'LEGAL-CONTEXT-2',
        status: 'active',
        tenantId: tenantOne,
      },
      {
        legalEntityId: suspended,
        legalName: 'Suspended entity',
        registrationCountry: 'CZ',
        registrationNumber: 'LEGAL-CONTEXT-3',
        status: 'suspended',
        tenantId: tenantOne,
      },
      {
        legalEntityId: foreign,
        legalName: 'Foreign entity',
        registrationCountry: 'CZ',
        registrationNumber: 'LEGAL-CONTEXT-4',
        status: 'active',
        tenantId: tenantTwo,
      },
    ]);

    assert.deepEqual(await Effect.runPromise(context.listActiveForTenant(tenantOne)), [
      { legalEntityId: activeTwo, legalName: 'Alpha entity' },
      { legalEntityId: activeOne, legalName: 'Zeta entity' },
    ]);
    assert.deepEqual(await Effect.runPromise(context.validateSelection(tenantOne, activeOne)), {
      legalEntityId: activeOne,
      legalName: 'Zeta entity',
    });
    assert.equal(
      (await Effect.runPromise(Effect.flip(context.validateSelection(tenantOne, suspended))))._tag,
      'LegalEntityContextInactiveError',
    );
    assert.equal(
      (await Effect.runPromise(Effect.flip(context.validateSelection(tenantOne, foreign))))._tag,
      'LegalEntityContextMissingError',
    );
  } finally {
    await cleanup();
    await pool.end();
  }
});
