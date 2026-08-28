import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off processEnv:off
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { makePrincipalResolver } from '../../src/auth/principal-resolver.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import {
  coreDatabaseSchema,
  principalAuthBindings,
  principals,
  tenants,
} from '../../src/db/schema.ts';

const tenantOne = '10000000-0000-4000-8000-000000000001';
const tenantTwo = '10000000-0000-4000-8000-000000000002';
const principalOne = '20000000-0000-4000-8000-000000000001';
const principalTwo = '20000000-0000-4000-8000-000000000002';
const subject = 'better-auth-integration-subject';

test('lists and selects multiple tenant-scoped principals and fails closed after access changes', async () => {
  const configuration = await Effect.runPromise(loadDatabaseConfig());
  const pool = new Pool({ connectionString: configuration.connectionString });
  const database = drizzle({ client: pool, schema: coreDatabaseSchema });
  const resolver = makePrincipalResolver({ executor: database });

  const cleanup = () =>
    database.transaction((transaction) =>
      transaction
        .delete(principalAuthBindings)
        .where(eq(principalAuthBindings.providerSubjectId, subject))
        .then(() =>
          transaction
            .delete(principals)
            .where(
              and(eq(principals.principalId, principalOne), eq(principals.tenantId, tenantOne)),
            ),
        )
        .then(() =>
          transaction
            .delete(principals)
            .where(
              and(eq(principals.principalId, principalTwo), eq(principals.tenantId, tenantTwo)),
            ),
        )
        .then(() => transaction.delete(tenants).where(eq(tenants.tenantId, tenantOne)))
        .then(() => transaction.delete(tenants).where(eq(tenants.tenantId, tenantTwo))),
    );

  try {
    await cleanup();
    await database.insert(tenants).values([
      {
        defaultLocale: 'en',
        name: 'Resolver tenant one',
        slug: 'resolver-tenant-one',
        status: 'active',
        tenantId: tenantOne,
      },
      {
        defaultLocale: 'en',
        name: 'Resolver tenant two',
        slug: 'resolver-tenant-two',
        status: 'active',
        tenantId: tenantTwo,
      },
    ]);
    await database.insert(principals).values([
      {
        displayName: 'Resolver principal one',
        kind: 'human',
        principalId: principalOne,
        status: 'active',
        tenantId: tenantOne,
      },
      {
        displayName: 'Resolver principal two',
        kind: 'human',
        principalId: principalTwo,
        status: 'active',
        tenantId: tenantTwo,
      },
    ]);
    await database.insert(principalAuthBindings).values([
      {
        principalId: principalOne,
        provider: 'better_auth',
        providerSubjectId: subject,
        status: 'active',
        subjectType: 'user',
        tenantId: tenantOne,
      },
      {
        principalId: principalTwo,
        provider: 'better_auth',
        providerSubjectId: subject,
        status: 'active',
        subjectType: 'user',
        tenantId: tenantTwo,
      },
    ]);

    assert.deepEqual(await Effect.runPromise(resolver.listAvailableTenants(subject)), [
      { name: 'Resolver tenant one', tenantId: tenantOne },
      { name: 'Resolver tenant two', tenantId: tenantTwo },
    ]);
    const resolvedOne = await Effect.runPromise(
      resolver.resolveBetterAuthUserForTenant(subject, tenantOne),
    );
    const resolvedTwo = await Effect.runPromise(
      resolver.resolveBetterAuthUserForTenant(subject, tenantTwo),
    );
    assert.equal(resolvedOne.principalId, principalOne);
    assert.equal(resolvedTwo.principalId, principalTwo);
    const foreignResolution = await Effect.runPromise(
      Effect.flip(
        resolver.resolveBetterAuthUserForTenant('foreign-better-auth-subject', tenantOne),
      ),
    );
    assert.equal(foreignResolution._tag, 'PrincipalBindingMissingError');

    await database
      .update(principalAuthBindings)
      .set({ revokedAt: new Date('2026-08-28T00:00:00.000Z'), status: 'revoked' })
      .where(eq(principalAuthBindings.tenantId, tenantOne));
    assert.deepEqual(await Effect.runPromise(resolver.listAvailableTenants(subject)), [
      { name: 'Resolver tenant two', tenantId: tenantTwo },
    ]);
    const revokedResolution = await Effect.runPromise(
      Effect.flip(resolver.resolveBetterAuthUserForTenant(subject, tenantOne)),
    );
    assert.equal(revokedResolution._tag, 'PrincipalBindingInactiveError');

    await database
      .update(principalAuthBindings)
      .set({ revokedAt: null, status: 'active' })
      .where(eq(principalAuthBindings.tenantId, tenantOne));
    await database
      .update(principals)
      .set({ status: 'disabled' })
      .where(eq(principals.principalId, principalOne));
    const inactivePrincipal = await Effect.runPromise(
      Effect.flip(resolver.resolveBetterAuthUserForTenant(subject, tenantOne)),
    );
    assert.equal(inactivePrincipal._tag, 'PrincipalInactiveError');

    await database
      .update(principals)
      .set({ status: 'active' })
      .where(eq(principals.principalId, principalOne));
    await database
      .update(tenants)
      .set({ status: 'suspended' })
      .where(eq(tenants.tenantId, tenantOne));
    const inactiveTenant = await Effect.runPromise(
      Effect.flip(resolver.resolveBetterAuthUserForTenant(subject, tenantOne)),
    );
    assert.equal(inactiveTenant._tag, 'TenantInactiveError');
  } finally {
    await cleanup();
    await pool.end();
  }
});
