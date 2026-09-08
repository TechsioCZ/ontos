import { Crypto, Effect, Redacted, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { acquirePoolResource, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { configureDatabasePool } from '../../../../packages/core-runtime/src/db/pool-configuration.ts';
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

const contactsModuleId = 'party.registry';

// Real server deadlines are what bound this fixture's finalizers: a stuck statement would
// otherwise keep a client checked out and hold `pool.end()` open past the acquisition
// deadline. Keep the shared connection bound and shorten the statement bound below that
// deadline. Never use query_timeout or a Promise race -- neither cancels server work.
const e2ePoolDeadlines = { connectionTimeoutMillis: 5000, statement_timeout: 10_000 } as const;

class E2eAuthorizationFixtureError extends Schema.TaggedError<E2eAuthorizationFixtureError>()(
  'E2eAuthorizationFixtureError',
  { reason: Schema.String },
) {}

interface FixtureTenant {
  readonly legalEntityId: string;
  readonly name: string;
  readonly principalId: string;
  readonly tenantId: string;
}

interface FixtureTenants {
  readonly first: FixtureTenant;
  readonly second: FixtureTenant;
}

// Database module activation does not grant access. Own the complete authorization
// chain for these disposable E2E identities instead of relying on bootstrap seeds.
const provisionContactsAccess = Effect.fn('provisionContactsAccess')(
  function* provisionContactsAccessEffect(e2eTenants: FixtureTenants) {
    const configuration = yield* loadSpiceDbConfig();
    if (!configuration.endpoint.startsWith('localhost:')) {
      return yield* Effect.fail(
        new E2eAuthorizationFixtureError({
          reason: 'E2E authorization fixtures require localhost SpiceDB',
        }),
      );
    }
    const client = yield* Effect.acquireRelease(
      Effect.sync(() =>
        v1.NewClient(
          configuration.preSharedKey,
          configuration.endpoint,
          configuration.insecureLocal
            ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
            : v1.ClientSecurity.SECURE,
          undefined,
          { interceptors: [deadlineInterceptor(5000)] },
        ),
      ),
      (acquired) => Effect.sync(() => acquired.close()),
    );
    const relationships = yield* Effect.forEach(
      Object.values(e2eTenants),
      ({ legalEntityId, principalId, tenantId }) =>
        Effect.gen(function* makeContactsRelationships() {
          const entityObject = toLegalEntityAccessObjectId(tenantId, legalEntityId);
          const moduleObject = toModuleAccessObjectId(tenantId, legalEntityId, contactsModuleId);
          if (entityObject === undefined || moduleObject === undefined) {
            return yield* Effect.fail(
              new E2eAuthorizationFixtureError({
                reason: 'Invalid E2E authorization object identifier',
              }),
            );
          }
          return (
            [
              ['tenant', tenantId, 'member', 'principal', principalId],
              ['legal_entity', entityObject, 'tenant', 'tenant', tenantId],
              ['legal_entity', entityObject, 'member', 'principal', principalId],
              ['module_access', moduleObject, 'legal_entity', 'legal_entity', entityObject],
              ['module_access', moduleObject, 'accessor', 'principal', principalId],
            ] as const
          ).map(([resourceType, resourceId, relation, subjectType, subjectId]) =>
            v1.Relationship.create({
              relation,
              resource: { objectId: resourceId, objectType: resourceType },
              subject: { object: { objectId: subjectId, objectType: subjectType } },
            }),
          );
        }),
      { concurrency: 'unbounded' },
    );
    const update = (operation: v1.RelationshipUpdate_Operation) =>
      Effect.tryPromise(
        async () =>
          await client.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: relationships.flat().map((relationship) => ({ operation, relationship })),
            }),
          ),
      );
    // Register first so even an indeterminate write acknowledgement is cleaned up.
    yield* Effect.addFinalizer(() =>
      update(v1.RelationshipUpdate_Operation.DELETE).pipe(Effect.orDie),
    );
    return yield* update(v1.RelationshipUpdate_Operation.TOUCH).pipe(Effect.uninterruptible);
  },
);

export const createAuthenticationFixture = Effect.fn('createAuthenticationFixture')(
  function* createAuthenticationFixtureEffect() {
    const crypto = yield* Crypto.Crypto;
    const fixtureId = yield* crypto.randomUUIDv4;
    const e2eCredentials = {
      email: `e2e.${fixtureId}@example.test`,
      password: 'e2e-correct-horse-battery-staple',
    };
    const makeTenant = (name: string) =>
      Effect.all({
        legalEntityId: crypto.randomUUIDv4,
        name: Effect.succeed(name),
        principalId: crypto.randomUUIDv4,
        tenantId: crypto.randomUUIDv4,
      });
    const e2eTenants = yield* Effect.all({
      first: makeTenant('E2E Alpha tenant'),
      second: makeTenant('E2E Zeta tenant'),
    });
    const {
      baseUrl: baseURL,
      connectionString,
      secret,
    } = yield* loadAuthConfig({ envPath: APP_ENV_PATH });

    const corePoolConfiguration = yield* configureDatabasePool(
      Redacted.make(connectionString),
      e2ePoolDeadlines,
    );
    const corePool = yield* acquirePoolResource(() => new Pool(corePoolConfiguration));
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
        const tenantIds = Object.values(e2eTenants).map(({ tenantId }) => tenantId);
        const principalIds = Object.values(e2eTenants).map(({ principalId }) => principalId);
        // Authenticated shell reads write evidence asynchronously. Let those writes
        // settle, then remove their E2E-owned rows before the referenced identities.
        yield* Effect.sleep('250 millis');
        yield* coreDatabase
          .delete(dataAccessEvents)
          .where(inArray(dataAccessEvents.principalId, principalIds));
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
          .where(inArray(dataAccessEvents.principalId, principalIds));
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
          .where(inArray(principalAuthBindings.principalId, principalIds));
        yield* coreDatabase
          .delete(tenantModuleStates)
          .where(inArray(tenantModuleStates.tenantId, tenantIds));
        yield* coreDatabase.delete(legalEntities).where(inArray(legalEntities.tenantId, tenantIds));
        yield* coreDatabase.delete(principals).where(inArray(principals.principalId, principalIds));
        yield* coreDatabase.delete(tenants).where(inArray(tenants.tenantId, tenantIds));
      },
    );

    yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
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
        slug: `e2e-alpha-${fixtureId}`,
        status: 'active',
        tenantId: e2eTenants.first.tenantId,
      },
      {
        defaultLocale: 'en',
        name: e2eTenants.second.name,
        slug: `e2e-zeta-${fixtureId}`,
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
      { moduleKey: contactsModuleId, state: 'active', tenantId: e2eTenants.first.tenantId },
      { moduleKey: contactsModuleId, state: 'active', tenantId: e2eTenants.second.tenantId },
      { moduleKey: 'e2e-first-module', state: 'active', tenantId: e2eTenants.first.tenantId },
      { moduleKey: 'e2e-second-module', state: 'active', tenantId: e2eTenants.second.tenantId },
    ]);
    yield* provisionContactsAccess(e2eTenants);
    return { credentials: e2eCredentials, tenants: e2eTenants };
  },
  Effect.provide(NodeCrypto.layer),
);

export type AuthenticationFixture = Effect.Success<ReturnType<typeof createAuthenticationFixture>>;
