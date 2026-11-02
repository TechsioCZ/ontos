import { NodeCrypto } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Crypto, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { makePrincipalResolver } from '../../src/auth/principal-resolver.ts';
import {
  StaffRoleTemplateAccountProvider,
  StaffRoleTemplateAccountsSchema,
} from '../../src/auth/staff-role-template-account-provider.ts';
import { staffRoleTemplateBindingsRead } from '../../src/auth/staff-role-template-bindings-read.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../src/auth/staff-authentication-namespace.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  coreRelations,
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../../src/db/schema.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

it.layer(NodeCrypto.layer, { excludeTestServices: true })('native staff role-template bindings', (suite) => {
  suite.effect('finds the same retained staff binding as login, only in its active company membership', () =>
    Effect.gen(function* nativeStaffRoleTemplateRead() {
      const crypto = yield* Crypto.Crypto;
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const adminClient = yield* makeTestPgClient(connections.admin.connectionString);
      const runtimeClient = yield* makeTestPgClient(connections.runtime.connectionString);
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const database = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const tenantId = yield* crypto.randomUUIDv4();
      const principalId = yield* crypto.randomUUIDv4();
      const authBindingId = yield* crypto.randomUUIDv4();
      const legalEntityId = yield* crypto.randomUUIDv4();
      const otherCompanyId = yield* crypto.randomUUIDv4();
      const providerSubjectId = yield* crypto.randomUUIDv4();
      const email = 'template@example.invalid';
      const accounts = yield* Schema.decodeEffect(StaffRoleTemplateAccountsSchema)([{ email, providerSubjectId }]);

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* removeNativeStaffRoleTemplateFixture() {
          yield* admin.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
          yield* admin.delete(principalCompanyMemberships).where(eq(principalCompanyMemberships.tenantId, tenantId));
          yield* admin.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId));
          yield* admin.delete(principals).where(eq(principals.tenantId, tenantId));
          yield* admin.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
          yield* admin.delete(tenants).where(eq(tenants.tenantId, tenantId));
        }).pipe(Effect.orDie),
      );
      yield* admin.insert(tenants).values({
        defaultLocale: 'cs',
        name: 'Staff role-template proof',
        slug: `staff-role-template-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* admin.insert(legalEntities).values(
        [legalEntityId, otherCompanyId].map((id) => ({
          legalEntityId: id,
          legalName: 'Staff template company',
          registrationCountry: 'CZ',
          registrationNumber: id,
          status: 'active' as const,
          tenantId,
        })),
      );
      yield* admin.insert(principals).values({
        displayName: 'Staff template',
        kind: 'human',
        principalId,
        status: 'active',
        tenantId,
      });
      yield* admin.insert(principalAuthBindings).values({
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        principalAuthBindingId: authBindingId,
        principalId,
        provider: 'better_auth',
        providerSubjectId,
        status: 'active',
        subjectType: 'user',
        tenantId,
      });
      yield* admin.insert(principalCompanyMemberships).values({
        affiliation: 'employee',
        legalEntityId,
        principalId,
        status: 'active',
        tenantId,
      });
      // The normal login resolver must recognize the same row that supplies the agent presets.
      const resolver = makePrincipalResolver(
        { executor: database },
        { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
      );
      expect(yield* resolver.resolveBetterAuthUserForPrincipal({ principalId, tenantId })).toBe(providerSubjectId);
      const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        authBindingId,
        authContextRef: `better-auth-session:${authBindingId}`,
        authMethod: 'session',
        legalEntityId,
        principalId,
        tenantId,
      });
      const runtime = makeReadRuntime(
        { executor: database },
        openModuleEntrypointGateway,
        testOperationalScopeResolver,
        {
          legalEntities: () => Effect.succeed([]),
          modules: () => Effect.succeed([]),
          resources: () => Effect.succeed([]),
          tenants: () => Effect.succeed([{ decision: 'allowed' as const, key: tenantId }]),
        },
        { databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT },
      );
      const read = (companyId: string) =>
        runtime
          .runRead({
            input: { emails: [email] },
            principal: { ...principal, legalEntityId: companyId },
            registration: staffRoleTemplateBindingsRead,
            transport: { correlationId: `staff-role-template-${companyId}` },
          })
          .pipe(
            Effect.provideService(StaffRoleTemplateAccountProvider, {
              lookup: () => Effect.succeed(accounts),
            }),
          );
      expect(yield* read(legalEntityId)).toEqual({ bindings: [{ email, principalId }] });
      expect(yield* read(otherCompanyId)).toEqual({ bindings: [] });
      yield* admin
        .update(principalCompanyMemberships)
        .set({ status: 'departed' })
        .where(eq(principalCompanyMemberships.tenantId, tenantId));
      expect(yield* read(legalEntityId)).toEqual({ bindings: [] });
    }),
  );
});
