import { Effect } from 'effect';
import { acquirePoolResource, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { betterAuth } from 'better-auth';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import {
  coreRelations,
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { loadAuthConfig } from '../../api/auth/config.ts';
import { account, session, user } from '../../api/auth/db/schema.ts';

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

export const createAuthenticationFixture = Effect.fn('createAuthenticationFixture')(
  function* createAuthenticationFixtureEffect() {
    const {
      baseUrl: baseURL,
      connectionString,
      secret,
    } = yield* loadAuthConfig({ envPath: APP_ENV_PATH });

    const corePool = yield* acquirePoolResource(() => new Pool({ connectionString }));
    const coreDatabase = yield* makeTestDatabaseFromPool(corePool, coreRelations);
    const { adapter, executor: authDatabase } = yield* makeAuthDatabase({ connectionString });
    const authentication = betterAuth({
      baseURL,
      database: adapter,
      emailAndPassword: {
        autoSignIn: false,
        enabled: true,
      },
      secret,
      trustedOrigins: [baseURL, 'http://127.0.0.1:3020'],
    });

    const cleanup = Effect.fn('cleanupAuthenticationFixture')(
      function* cleanupAuthenticationFixtureEffect() {
        // Authenticated shell reads write evidence asynchronously. Let those writes
        // settle, then remove their E2E-owned rows before the referenced identities.
        yield* Effect.sleep('250 millis');
        yield* coreDatabase
          .delete(dataAccessEvents)
          .where(
            inArray(dataAccessEvents.principalId, [
              e2eTenants.first.principalId,
              e2eTenants.second.principalId,
            ]),
          );
        const existingUsers = yield* authDatabase
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, e2eCredentials.email));

        yield* Effect.all(
          existingUsers.map((existingUser) =>
            Effect.gen(function* removeExistingAuthUser() {
              yield* authDatabase.delete(session).where(eq(session.userId, existingUser.id));
              yield* authDatabase.delete(account).where(eq(account.userId, existingUser.id));
              yield* authDatabase.delete(user).where(eq(user.id, existingUser.id));
            }),
          ),
          { concurrency: 'unbounded', discard: true },
        );
        // A page read can finish its asynchronous evidence write while auth rows
        // are being removed. Clear that final E2E-owned batch before deleting the
        // binding referenced by the evidence foreign key.
        yield* coreDatabase
          .delete(dataAccessEvents)
          .where(
            inArray(dataAccessEvents.principalId, [
              e2eTenants.first.principalId,
              e2eTenants.second.principalId,
            ]),
          );
        yield* Effect.all(
          existingUsers.map((existingUser) =>
            coreDatabase
              .delete(principalAuthBindings)
              .where(eq(principalAuthBindings.providerSubjectId, existingUser.id)),
          ),
          { concurrency: 'unbounded', discard: true },
        );
        yield* coreDatabase
          .delete(principalAuthBindings)
          .where(eq(principalAuthBindings.principalId, e2eTenants.first.principalId));
        yield* coreDatabase
          .delete(principalAuthBindings)
          .where(eq(principalAuthBindings.principalId, e2eTenants.second.principalId));
        yield* coreDatabase
          .delete(tenantModuleStates)
          .where(eq(tenantModuleStates.tenantId, e2eTenants.first.tenantId));
        yield* coreDatabase
          .delete(tenantModuleStates)
          .where(eq(tenantModuleStates.tenantId, e2eTenants.second.tenantId));
        yield* coreDatabase
          .delete(legalEntities)
          .where(eq(legalEntities.tenantId, e2eTenants.first.tenantId));
        yield* coreDatabase
          .delete(legalEntities)
          .where(eq(legalEntities.tenantId, e2eTenants.second.tenantId));
        yield* coreDatabase
          .delete(principals)
          .where(eq(principals.principalId, e2eTenants.first.principalId));
        yield* coreDatabase
          .delete(principals)
          .where(eq(principals.principalId, e2eTenants.second.principalId));
        yield* coreDatabase.delete(tenants).where(eq(tenants.tenantId, e2eTenants.first.tenantId));
        yield* coreDatabase.delete(tenants).where(eq(tenants.tenantId, e2eTenants.second.tenantId));
      },
    );

    yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
    yield* cleanup();
    const createdUser = yield* Effect.tryPromise(
      async () =>
        await authentication.api.signUpEmail({
          body: {
            email: e2eCredentials.email,
            name: 'E2E user',
            password: e2eCredentials.password,
          },
        }),
    ).pipe(Effect.uninterruptible);
    yield* coreDatabase.insert(tenants).values([
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
    yield* coreDatabase.insert(principals).values([
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
    yield* coreDatabase.insert(legalEntities).values([
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
    yield* coreDatabase.insert(principalAuthBindings).values([
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
    yield* coreDatabase.insert(tenantModuleStates).values([
      { moduleKey: 'party.registry', state: 'active', tenantId: e2eTenants.first.tenantId },
      { moduleKey: 'party.registry', state: 'active', tenantId: e2eTenants.second.tenantId },
      { moduleKey: 'e2e-first-module', state: 'active', tenantId: e2eTenants.first.tenantId },
      { moduleKey: 'e2e-second-module', state: 'active', tenantId: e2eTenants.second.tenantId },
    ]);
  },
);
