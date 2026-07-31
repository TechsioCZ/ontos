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

test('resolves one tenant and observes ambiguity, revocation, and inactive owners', async () => {
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

    const ambiguous = await Effect.runPromise(Effect.flip(resolver.resolveBetterAuthUser(subject)));
    assert.equal(ambiguous._tag, 'PrincipalBindingAmbiguousError');

    await database
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.tenantId, tenantTwo));
    const resolved = await Effect.runPromise(resolver.resolveBetterAuthUser(subject));
    assert.equal(resolved.tenantId, tenantOne);
    assert.equal(resolved.principalId, principalOne);

    await database
      .update(principalAuthBindings)
      .set({ status: 'revoked' })
      .where(eq(principalAuthBindings.tenantId, tenantOne));
    const revoked = await Effect.runPromise(Effect.flip(resolver.resolveBetterAuthUser(subject)));
    assert.equal(revoked._tag, 'PrincipalBindingInactiveError');

    await database
      .update(principalAuthBindings)
      .set({ status: 'active' })
      .where(eq(principalAuthBindings.tenantId, tenantOne));
    await database
      .update(principals)
      .set({ status: 'disabled' })
      .where(eq(principals.principalId, principalOne));
    const inactivePrincipal = await Effect.runPromise(
      Effect.flip(resolver.resolveBetterAuthUser(subject)),
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
      Effect.flip(resolver.resolveBetterAuthUser(subject)),
    );
    assert.equal(inactiveTenant._tag, 'TenantInactiveError');
  } finally {
    await cleanup();
    await pool.end();
  }
});
