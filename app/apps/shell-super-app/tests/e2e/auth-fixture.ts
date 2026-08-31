import { setTimeout as delay } from 'node:timers/promises';
import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { config as loadDotenv } from 'dotenv';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  coreDatabaseSchema,
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { account, authDatabaseSchema, session, user } from '../../api/auth/db/schema.ts';
import { createProjectsE2eCustomersFixture } from '../../../../verticals/projects/tests/support/e2e-customers.ts';

export { projectsE2eCustomers as e2eCustomers } from '../../../../verticals/projects/tests/support/e2e-customers.ts';
export { projectsE2eContacts as e2eContacts } from '../../../../verticals/projects/tests/support/e2e-customers.ts';

export const e2eCredentials = {
  email: 'e2e.user@example.test',
  password: 'e2e-correct-horse-battery-staple',
} as const;

export const e2eTenants = {
  first: {
    legalEntityId: '55000000-0000-4000-8000-000000000001',
    name: 'E2E Alpha tenant',
    principalId: '60000000-0000-4000-8000-000000000001',
    tenantId: '50000000-0000-4000-8000-000000000001',
  },
  second: {
    legalEntityId: '55000000-0000-4000-8000-000000000002',
    name: 'E2E Zeta tenant',
    principalId: '60000000-0000-4000-8000-000000000002',
    tenantId: '50000000-0000-4000-8000-000000000002',
  },
} as const;

export const createAuthenticationFixture = async () => {
  loadDotenv({
    path: APP_ENV_PATH,
    quiet: true,
  });
  const adminConnectionString = process.env['DATABASE_ADMIN_URL'];
  const connectionString = process.env['DATABASE_URL'];
  const secret = process.env['BETTER_AUTH_SECRET'];
  const baseURL = process.env['BETTER_AUTH_URL'];

  if (
    adminConnectionString === undefined ||
    connectionString === undefined ||
    secret === undefined ||
    baseURL === undefined
  ) {
    throw new Error('The E2E authentication fixture requires the root development environment');
  }

  const corePool = new Pool({ connectionString });
  const authPool = new Pool({ connectionString });
  const coreDatabase = drizzle({ client: corePool, schema: coreDatabaseSchema });
  const authDatabase = drizzle({ client: authPool, schema: authDatabaseSchema });
  const projectsCustomersFixture = createProjectsE2eCustomersFixture({
    connectionString: adminConnectionString,
    tenantIds: [e2eTenants.first.tenantId, e2eTenants.second.tenantId],
  });
  const authentication = betterAuth({
    baseURL,
    database: drizzleAdapter(authDatabase, {
      provider: 'pg',
      schema: authDatabaseSchema,
    }),
    emailAndPassword: {
      autoSignIn: false,
      enabled: true,
    },
    secret,
    trustedOrigins: [baseURL, 'http://127.0.0.1:3020'],
  });

  const cleanup = async () => {
    // Authenticated shell reads write evidence asynchronously. Let those writes
    // settle, then remove their E2E-owned rows before the referenced identities.
    await delay(250);
    await coreDatabase
      .delete(dataAccessEvents)
      .where(
        inArray(dataAccessEvents.principalId, [
          e2eTenants.first.principalId,
          e2eTenants.second.principalId,
        ]),
      );
    const existingUsers = await authDatabase
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, e2eCredentials.email));

    await Promise.all(
      existingUsers.map(async (existingUser) => {
        await authDatabase.delete(session).where(eq(session.userId, existingUser.id));
        await authDatabase.delete(account).where(eq(account.userId, existingUser.id));
        await authDatabase.delete(user).where(eq(user.id, existingUser.id));
      }),
    );
    // A page read can finish its asynchronous evidence write while auth rows
    // are being removed. Clear that final E2E-owned batch before deleting the
    // binding referenced by the evidence foreign key.
    await coreDatabase
      .delete(dataAccessEvents)
      .where(
        inArray(dataAccessEvents.principalId, [
          e2eTenants.first.principalId,
          e2eTenants.second.principalId,
        ]),
      );
    await Promise.all(
      existingUsers.map((existingUser) =>
        coreDatabase
          .delete(principalAuthBindings)
          .where(eq(principalAuthBindings.providerSubjectId, existingUser.id)),
      ),
    );
    await coreDatabase
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.principalId, e2eTenants.first.principalId));
    await coreDatabase
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.principalId, e2eTenants.second.principalId));
    await coreDatabase
      .delete(tenantModuleStates)
      .where(eq(tenantModuleStates.tenantId, e2eTenants.first.tenantId));
    await coreDatabase
      .delete(tenantModuleStates)
      .where(eq(tenantModuleStates.tenantId, e2eTenants.second.tenantId));
    await projectsCustomersFixture.cleanup();
    await coreDatabase
      .delete(legalEntities)
      .where(eq(legalEntities.tenantId, e2eTenants.first.tenantId));
    await coreDatabase
      .delete(legalEntities)
      .where(eq(legalEntities.tenantId, e2eTenants.second.tenantId));
    await coreDatabase
      .delete(principals)
      .where(eq(principals.principalId, e2eTenants.first.principalId));
    await coreDatabase
      .delete(principals)
      .where(eq(principals.principalId, e2eTenants.second.principalId));
    await coreDatabase.delete(tenants).where(eq(tenants.tenantId, e2eTenants.first.tenantId));
    await coreDatabase.delete(tenants).where(eq(tenants.tenantId, e2eTenants.second.tenantId));
  };

  await cleanup();
  const createdUser = await authentication.api.signUpEmail({
    body: {
      email: e2eCredentials.email,
      name: 'E2E user',
      password: e2eCredentials.password,
    },
  });
  await coreDatabase.insert(tenants).values([
    {
      defaultLocale: 'en',
      name: e2eTenants.first.name,
      slug: 'e2e-alpha-tenant',
      status: 'active',
      tenantId: e2eTenants.first.tenantId,
    },
    {
      defaultLocale: 'en',
      name: e2eTenants.second.name,
      slug: 'e2e-zeta-tenant',
      status: 'active',
      tenantId: e2eTenants.second.tenantId,
    },
  ]);
  await coreDatabase.insert(principals).values([
    {
      displayName: 'E2E user',
      kind: 'human',
      principalId: e2eTenants.first.principalId,
      status: 'active',
      tenantId: e2eTenants.first.tenantId,
    },
    {
      displayName: 'E2E user second tenant',
      kind: 'human',
      principalId: e2eTenants.second.principalId,
      status: 'active',
      tenantId: e2eTenants.second.tenantId,
    },
  ]);
  await coreDatabase.insert(legalEntities).values([
    {
      legalEntityId: e2eTenants.first.legalEntityId,
      legalName: 'E2E Alpha company',
      registrationCountry: 'CZ',
      registrationNumber: 'E2E-ALPHA',
      status: 'active',
      tenantId: e2eTenants.first.tenantId,
    },
    {
      legalEntityId: e2eTenants.second.legalEntityId,
      legalName: 'E2E Zeta company',
      registrationCountry: 'CZ',
      registrationNumber: 'E2E-ZETA',
      status: 'active',
      tenantId: e2eTenants.second.tenantId,
    },
  ]);
  await coreDatabase.insert(principalAuthBindings).values([
    {
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      principalId: e2eTenants.first.principalId,
      provider: 'better_auth',
      providerSubjectId: createdUser.user.id,
      status: 'active',
      subjectType: 'user',
      tenantId: e2eTenants.first.tenantId,
    },
    {
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      principalId: e2eTenants.second.principalId,
      provider: 'better_auth',
      providerSubjectId: createdUser.user.id,
      status: 'active',
      subjectType: 'user',
      tenantId: e2eTenants.second.tenantId,
    },
  ]);
  await coreDatabase.insert(tenantModuleStates).values([
    { moduleKey: 'projects.core', state: 'active', tenantId: e2eTenants.first.tenantId },
    { moduleKey: 'projects.core', state: 'active', tenantId: e2eTenants.second.tenantId },
    { moduleKey: 'e2e-first-module', state: 'active', tenantId: e2eTenants.first.tenantId },
    { moduleKey: 'e2e-second-module', state: 'active', tenantId: e2eTenants.second.tenantId },
  ]);
  await projectsCustomersFixture.seed(e2eTenants.first.tenantId);

  return async () => {
    try {
      await cleanup();
    } finally {
      await Promise.all([authPool.end(), corePool.end(), projectsCustomersFixture.close()]);
    }
  };
};
