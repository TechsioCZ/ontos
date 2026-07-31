import path from 'node:path';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { config as loadDotenv } from 'dotenv';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  coreDatabaseSchema,
  principalAuthBindings,
  principals,
  tenants,
} from '@app/core-runtime/db/schema';
import { account, authDatabaseSchema, session, user } from '../../api/auth/db/schema.ts';

export const e2eCredentials = {
  email: 'e2e.user@example.test',
  password: 'e2e-correct-horse-battery-staple',
} as const;

const tenantId = '50000000-0000-4000-8000-000000000001';
const principalId = '60000000-0000-4000-8000-000000000001';

export const createAuthenticationFixture = async () => {
  loadDotenv({
    path: path.resolve(process.cwd(), '../../.env'),
    quiet: true,
  });
  const connectionString = process.env['DATABASE_URL'];
  const secret = process.env['BETTER_AUTH_SECRET'];
  const baseURL = process.env['BETTER_AUTH_URL'];

  if (connectionString === undefined || secret === undefined || baseURL === undefined) {
    throw new Error('The E2E authentication fixture requires the root development environment');
  }

  const corePool = new Pool({ connectionString });
  const authPool = new Pool({ connectionString });
  const coreDatabase = drizzle({ client: corePool, schema: coreDatabaseSchema });
  const authDatabase = drizzle({ client: authPool, schema: authDatabaseSchema });
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
    const existingUsers = await authDatabase
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, e2eCredentials.email));

    await Promise.all(
      existingUsers.map(async (existingUser) => {
        await coreDatabase
          .delete(principalAuthBindings)
          .where(eq(principalAuthBindings.providerSubjectId, existingUser.id));
        await authDatabase.delete(session).where(eq(session.userId, existingUser.id));
        await authDatabase.delete(account).where(eq(account.userId, existingUser.id));
        await authDatabase.delete(user).where(eq(user.id, existingUser.id));
      }),
    );
    await coreDatabase
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.principalId, principalId));
    await coreDatabase.delete(principals).where(eq(principals.principalId, principalId));
    await coreDatabase.delete(tenants).where(eq(tenants.tenantId, tenantId));
  };

  await cleanup();
  const createdUser = await authentication.api.signUpEmail({
    body: {
      email: e2eCredentials.email,
      name: 'E2E user',
      password: e2eCredentials.password,
    },
  });
  await coreDatabase.insert(tenants).values({
    defaultLocale: 'en',
    name: 'E2E authentication tenant',
    slug: 'e2e-authentication-tenant',
    status: 'active',
    tenantId,
  });
  await coreDatabase.insert(principals).values({
    displayName: 'E2E user',
    kind: 'human',
    principalId,
    status: 'active',
    tenantId,
  });
  await coreDatabase.insert(principalAuthBindings).values({
    principalId,
    provider: 'better_auth',
    providerSubjectId: createdUser.user.id,
    status: 'active',
    subjectType: 'user',
    tenantId,
  });

  return async () => {
    try {
      await cleanup();
    } finally {
      await Promise.all([authPool.end(), corePool.end()]);
    }
  };
};
