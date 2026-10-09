import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makePrincipalResolver } from '../../src/auth/principal-resolver.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { principalAuthBindings, principals, tenants } from '../../src/db/schema.ts';

const tenantOne = '10000000-0000-4000-8000-000000000001';
const tenantTwo = '10000000-0000-4000-8000-000000000002';
const principalOne = '20000000-0000-4000-8000-000000000001';
const principalTwo = '20000000-0000-4000-8000-000000000002';
const commercePrincipal = '20000000-0000-4000-8000-000000000003';
const apiKeyBinding = '30000000-0000-4000-8000-000000000001';
const subject = 'better-auth-integration-subject';
const apiKeySubject = 'better-auth-integration-api-key';
const staffAuthenticationNamespaceId = 'test.staff.better-auth.v1';
const commerceAuthenticationNamespaceId = 'test.commerce.identity.v1';

it.live('lists and selects multiple tenant-scoped principals and fails closed after access changes', () =>
  Effect.gen(function* principalResolverIntegration() {
    const configuration = yield* loadDatabaseConfig();
    const { executor: database } = yield* makeCoreDatabase(configuration);
    const resolver = makePrincipalResolver(
      { executor: database },
      { authenticationNamespaceId: staffAuthenticationNamespaceId },
    );
    const cleanup = Effect.gen(function* cleanPrincipalResolverFixtures() {
      yield* database.delete(principalAuthBindings).where(eq(principalAuthBindings.providerSubjectId, subject));
      yield* database.delete(principalAuthBindings).where(eq(principalAuthBindings.providerSubjectId, apiKeySubject));
      yield* database
        .delete(principals)
        .where(and(eq(principals.principalId, principalOne), eq(principals.tenantId, tenantOne)));
      yield* database
        .delete(principals)
        .where(and(eq(principals.principalId, principalTwo), eq(principals.tenantId, tenantTwo)));
      yield* database
        .delete(principals)
        .where(and(eq(principals.principalId, commercePrincipal), eq(principals.tenantId, tenantOne)));
      yield* database.delete(tenants).where(eq(tenants.tenantId, tenantOne));
      yield* database.delete(tenants).where(eq(tenants.tenantId, tenantTwo));
    });

    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* database.insert(tenants).values([
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
    yield* database.insert(principals).values([
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
      {
        displayName: 'Resolver Commerce principal',
        kind: 'human',
        principalId: commercePrincipal,
        status: 'active',
        tenantId: tenantOne,
      },
    ]);
    yield* database.insert(principalAuthBindings).values([
      {
        authenticationNamespaceId: staffAuthenticationNamespaceId,
        principalId: principalOne,
        provider: 'better_auth',
        providerSubjectId: subject,
        status: 'active',
        subjectType: 'user',
        tenantId: tenantOne,
      },
      {
        authenticationNamespaceId: staffAuthenticationNamespaceId,
        principalId: principalTwo,
        provider: 'better_auth',
        providerSubjectId: subject,
        status: 'active',
        subjectType: 'user',
        tenantId: tenantTwo,
      },
      {
        authenticationNamespaceId: commerceAuthenticationNamespaceId,
        principalId: commercePrincipal,
        provider: 'better_auth',
        providerSubjectId: subject,
        status: 'active',
        subjectType: 'user',
        tenantId: tenantOne,
      },
      {
        authenticationNamespaceId: staffAuthenticationNamespaceId,
        principalAuthBindingId: apiKeyBinding,
        principalId: principalOne,
        provider: 'better_auth',
        providerSubjectId: apiKeySubject,
        status: 'disabled',
        subjectType: 'api_key',
        tenantId: tenantOne,
      },
    ]);

    expect(yield* resolver.listAvailableTenants(subject)).toEqual([
      { name: 'Resolver tenant one', tenantId: tenantOne },
      { name: 'Resolver tenant two', tenantId: tenantTwo },
    ]);
    const resolvedOne = yield* resolver.resolveBetterAuthUserForTenant(subject, tenantOne);
    const resolvedTwo = yield* resolver.resolveBetterAuthUserForTenant(subject, tenantTwo);
    expect(resolvedOne.principalId).toBe(principalOne);
    expect(resolvedTwo.principalId).toBe(principalTwo);
    const foreignResolution = yield* Effect.flip(
      resolver.resolveBetterAuthUserForTenant('foreign-better-auth-subject', tenantOne),
    );
    expect(Predicate.isTagged(foreignResolution, 'PrincipalBindingMissingError')).toBe(true);
    const disabledApiKeyResolution = yield* Effect.flip(
      resolver.resolveApiKeyBindingSubject({
        authBindingId: apiKeyBinding,
        principalId: principalOne,
        tenantId: tenantOne,
      }),
    );
    expect(Predicate.isTagged(disabledApiKeyResolution, 'PrincipalBindingInactiveError')).toBe(true);

    yield* database
      .update(principalAuthBindings)
      .set({
        revokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-07T00:00:00.000Z')),
        status: 'revoked',
      })
      .where(
        and(
          eq(principalAuthBindings.tenantId, tenantOne),
          eq(principalAuthBindings.authenticationNamespaceId, staffAuthenticationNamespaceId),
        ),
      );
    expect(yield* resolver.listAvailableTenants(subject)).toEqual([
      { name: 'Resolver tenant two', tenantId: tenantTwo },
    ]);
    const revokedResolution = yield* Effect.flip(resolver.resolveBetterAuthUserForTenant(subject, tenantOne));
    expect(Predicate.isTagged(revokedResolution, 'PrincipalBindingInactiveError')).toBe(true);

    yield* database
      .update(principalAuthBindings)
      .set({ revokedAt: null, status: 'active' })
      .where(
        and(
          eq(principalAuthBindings.tenantId, tenantOne),
          eq(principalAuthBindings.authenticationNamespaceId, staffAuthenticationNamespaceId),
        ),
      );
    yield* database.update(principals).set({ status: 'disabled' }).where(eq(principals.principalId, principalOne));
    const inactivePrincipal = yield* Effect.flip(resolver.resolveBetterAuthUserForTenant(subject, tenantOne));
    expect(Predicate.isTagged(inactivePrincipal, 'PrincipalInactiveError')).toBe(true);

    yield* database.update(principals).set({ status: 'active' }).where(eq(principals.principalId, principalOne));
    yield* database.update(tenants).set({ status: 'suspended' }).where(eq(tenants.tenantId, tenantOne));
    const inactiveTenant = yield* Effect.flip(resolver.resolveBetterAuthUserForTenant(subject, tenantOne));
    expect(Predicate.isTagged(inactiveTenant, 'TenantInactiveError')).toBe(true);
  }),
);
