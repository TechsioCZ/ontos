import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off processEnv:off
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { makePrincipalResolver } from '@app/core-runtime';
import {
  coreDatabaseSchema,
  principalAuthBindings,
  principals,
  tenants,
} from '@app/core-runtime/db/schema';
import { loadAuthConfig } from '../../api/auth/config.ts';
import { account, authDatabaseSchema, session, user } from '../../api/auth/db/schema.ts';
import { makeAuthenticationService } from '../../api/auth/service.ts';

const email = 'better-auth-runtime@example.test';
const password = 'correct-horse-battery-staple';
const tenantId = '30000000-0000-4000-8000-000000000001';
const principalId = '40000000-0000-4000-8000-000000000001';

const cookieHeader = (setCookieHeaders: readonly string[]) =>
  setCookieHeaders.map((header) => header.split(';')[0]).join('; ');

test('creates, resolves, persists, revokes, and signs out a Better Auth session', async () => {
  const configuration = await Effect.runPromise(loadAuthConfig());
  const corePool = new Pool({ connectionString: configuration.connectionString });
  const authPool = new Pool({ connectionString: configuration.connectionString });
  const coreDatabase = drizzle({ client: corePool, schema: coreDatabaseSchema });
  const authDatabase = drizzle({ client: authPool, schema: authDatabaseSchema });
  const resolver = makePrincipalResolver({ executor: coreDatabase });
  const authentication = makeAuthenticationService(configuration, authDatabase, resolver, {
    allowFixtureSignUp: true,
  });

  const cleanup = async () => {
    const existingUsers = await authDatabase
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));

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

  try {
    await cleanup();
    const betterAuthUserId = await Effect.runPromise(
      authentication.createFixtureUser(email, 'Runtime fixture', password),
    );
    await coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Authentication runtime tenant',
      slug: 'authentication-runtime-tenant',
      status: 'active',
      tenantId,
    });
    await coreDatabase.insert(principals).values({
      displayName: 'Runtime fixture',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    await coreDatabase.insert(principalAuthBindings).values({
      principalId,
      provider: 'better_auth',
      providerSubjectId: betterAuthUserId,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });

    const requestHeaders = new Headers({
      origin: configuration.baseUrl,
    });
    const invalid = await Effect.runPromise(
      Effect.flip(authentication.signIn(email, 'wrong-password', requestHeaders)),
    );
    assert.equal(invalid._tag, 'InvalidCredentialsError');

    const signedIn = await Effect.runPromise(
      authentication.signIn(email, password, requestHeaders),
    );
    assert.equal(signedIn.identity.email, email);
    assert.equal(signedIn.identity.principalId, principalId);
    assert.ok(signedIn.setCookieHeaders.length > 0);

    const authenticatedHeaders = new Headers({
      cookie: cookieHeader(signedIn.setCookieHeaders),
      origin: configuration.baseUrl,
    });
    const current = await Effect.runPromise(authentication.currentSession(authenticatedHeaders));
    assert.equal(current.identity?.tenantId, tenantId);

    await coreDatabase
      .update(principalAuthBindings)
      .set({ status: 'revoked' })
      .where(eq(principalAuthBindings.providerSubjectId, betterAuthUserId));
    const revoked = await Effect.runPromise(
      Effect.flip(authentication.currentSession(authenticatedHeaders)),
    );
    assert.equal(revoked._tag, 'OntosIdentityForbiddenError');

    await coreDatabase
      .update(principalAuthBindings)
      .set({ status: 'active' })
      .where(eq(principalAuthBindings.providerSubjectId, betterAuthUserId));
    const signedOut = await Effect.runPromise(authentication.signOut(authenticatedHeaders));
    assert.ok(signedOut.setCookieHeaders.length >= 3);
    assert.ok(signedOut.setCookieHeaders.every((header) => !header.includes(password)));

    const anonymous = await Effect.runPromise(
      authentication.currentSession(
        new Headers({
          cookie: cookieHeader(signedOut.setCookieHeaders),
          origin: configuration.baseUrl,
        }),
      ),
    );
    assert.equal(anonymous.identity, null);
  } finally {
    await cleanup();
    await Promise.all([authPool.end(), corePool.end()]);
  }
});
