import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Context, Effect, Match } from 'effect';

import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import { bootstrapScopesOf } from '../../../../packages/core-runtime/src/access/bootstrap/persistence.ts';
import { LegalEntityIdSchema, TenantIdSchema } from '../../../../packages/core-runtime/src/access/ids.ts';
import {
  accessScopeFences,
  accessScopes,
  accessWorkloadBindings,
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  domainEvents,
  evidenceReferences,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { layerTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { acquireFixturePgClient } from './fixture-pg-client.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import type { CounterpartyInvitationRealm } from './counterparty-invitation-acceptance.ts';

/** The Commerce portal's own authentication provider, which every Principal Auth Binding here names. */
const PORTAL_PROVIDER = 'commerce-portal-better-auth';

/**
 * The Core rows a Counterparty invitation acceptance needs: the Tenant, the three Principals the
 * scenario acts as, the Selling Legal Entity the journey names, the Commerce module state, the two
 * session bindings the gateway assertions present, and the Ready access scopes the one gate pins
 * every protected write to (O51, O73).
 *
 * The access scopes and fences are append-only by design (Core never removes them), so the Tenant
 * and Legal Entity they pin are retained with them, and so are the Principals any access intent a
 * scenario grants names; every mutable row the fixture created is removed again on scope close.
 */

const COMMERCE_MODULE_KEY = 'commerce.customer-context';

class CoreRealmDatabase extends Context.Service<CoreRealmDatabase, TestDatabaseFromClient<typeof coreRelations>>()(
  '@app/commerce-customer-context/tests/support/CoreRealmDatabase',
) {}

/** One portal person: a human Principal of the Tenant with an active Commerce portal session binding. */
export interface CommercePortalCorePerson {
  readonly authBindingId: string;
  readonly displayName: string;
  readonly principalId: string;
  readonly providerSubjectId: string;
}

/** The Tenant, its Selling Legal Entity, the Storefront workload that acts for portal people, and those people. */
export interface CommercePortalCoreRealm {
  readonly legalEntityId: string;
  readonly people: readonly CommercePortalCorePerson[];
  readonly storefront: { readonly authBindingId: string; readonly principalId: string };
  readonly tenantId: string;
  readonly title: string;
}

/**
 * The Core rows a governed Commerce portal caller of this Tenant reads: the Tenant, the Selling Legal Entity, the
 * Commerce module state, the Storefront workload Principal and its workload binding, every portal person as a human
 * Principal with an active session binding, and the Ready access scopes the one gate pins every protected write to
 * (O51, O73).
 */
export const seedCommercePortalCoreRealm = Effect.fnUntraced(function* seedCommercePortalCoreRealm(
  realm: CommercePortalCoreRealm,
) {
  const connections = yield* loadDatabaseConnectionPair();
  const adminClient = yield* acquireFixturePgClient(connections.admin.connectionString, 2);
  const admin = yield* CoreRealmDatabase.pipe(
    Effect.provide(layerTestDatabaseFromClient(CoreRealmDatabase, adminClient, coreRelations)),
  );
  const cleanup = Effect.gen(function* removeCoreRows() {
    for (const table of [
      outboxMessages,
      domainEvents,
      auditEvents,
      dataAccessEvents,
      evidenceReferences,
      actionInvocations,
      accessWorkloadBindings,
      principalAuthBindings,
      tenantModuleStates,
    ]) {
      yield* admin.delete(table).where(eq(table.tenantId, realm.tenantId));
    }
  });
  yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
  yield* admin.insert(tenants).values({
    defaultLocale: 'en',
    name: realm.title,
    slug: `commerce-portal-realm-${realm.tenantId}`,
    status: 'active',
    tenantId: realm.tenantId,
  });
  yield* admin.insert(principals).values([
    {
      displayName: `${realm.title} storefront client`,
      kind: 'system',
      principalId: realm.storefront.principalId,
      status: 'active',
      tenantId: realm.tenantId,
    },
    ...realm.people.map((person) => ({
      displayName: person.displayName,
      kind: 'human' as const,
      principalId: person.principalId,
      status: 'active' as const,
      tenantId: realm.tenantId,
    })),
  ]);
  yield* admin.insert(legalEntities).values({
    legalEntityId: realm.legalEntityId,
    legalName: `${realm.title} selling entity`,
    registrationCountry: 'CZ',
    registrationNumber: `commerce-portal-realm-${realm.legalEntityId}`,
    status: 'active',
    tenantId: realm.tenantId,
  });
  yield* admin.insert(tenantModuleStates).values({
    moduleKey: COMMERCE_MODULE_KEY,
    state: 'active',
    tenantId: realm.tenantId,
  });
  // The access gate re-decides under the shared writer fence immediately before every protected
  // owner write, so the tenant and legal-entity scopes must exist and both fences must be Ready
  // (O51, C24). The fixture seeds them the way production bootstrap does — idempotently, and never
  // as an implicit grant — and never removes them, because Core retains access scopes forever.
  const bootstrapScopes = bootstrapScopesOf(TenantIdSchema.make(realm.tenantId), [
    LegalEntityIdSchema.make(realm.legalEntityId),
  ]);
  yield* admin
    .insert(accessScopes)
    .values(
      bootstrapScopes.map((scope) =>
        Match.value(scope).pipe(
          Match.tag('TenantContext', (tenantScope) => ({
            legalEntityId: null,
            scopeId: tenantScope.scopeId,
            tenantContextId: realm.tenantId,
            tenantId: realm.tenantId,
          })),
          Match.tag('LegalEntity', (legalEntityScope) => ({
            legalEntityId: legalEntityScope.legalEntityId,
            scopeId: legalEntityScope.scopeId,
            tenantContextId: null,
            tenantId: realm.tenantId,
          })),
          Match.exhaustive,
        ),
      ),
    )
    .onConflictDoNothing();
  yield* admin
    .insert(accessScopeFences)
    .values(
      bootstrapScopes.map((scope) => ({
        owningOperationId: null,
        revision: 1,
        scopeId: scope.scopeId,
        state: 'Ready' as const,
        tenantId: realm.tenantId,
      })),
    )
    .onConflictDoNothing();
  yield* admin
    .insert(accessWorkloadBindings)
    .values({
      bindingId: randomUUID(),
      incarnation: randomUUID(),
      principalId: realm.storefront.principalId,
      status: 'active',
      tenantId: realm.tenantId,
      workloadKey: 'commerce.storefront-client',
    })
    .onConflictDoNothing();
  yield* admin.insert(principalAuthBindings).values([
    {
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: realm.storefront.authBindingId,
      principalId: realm.storefront.principalId,
      provider: PORTAL_PROVIDER,
      providerSubjectId: `commerce-portal-storefront-${realm.storefront.principalId}`,
      status: 'active',
      subjectType: 'user',
      tenantId: realm.tenantId,
    },
    ...realm.people.map((person) => ({
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: person.authBindingId,
      principalId: person.principalId,
      provider: PORTAL_PROVIDER,
      providerSubjectId: person.providerSubjectId,
      status: 'active' as const,
      subjectType: 'user' as const,
      tenantId: realm.tenantId,
    })),
  ]);
  return admin;
});

/** The Core rows a Counterparty invitation acceptance needs: its inviter and recipient are the portal people. */
export const seedCounterpartyInvitationCoreRealm = (realm: CounterpartyInvitationRealm) =>
  seedCommercePortalCoreRealm({
    legalEntityId: realm.legalEntityId,
    people: [
      {
        authBindingId: realm.inviterAuthBindingId,
        displayName: 'Counterparty access administrator',
        principalId: realm.inviterPrincipalId,
        providerSubjectId: `counterparty-invitation-inviter-${realm.inviterPrincipalId}`,
      },
      {
        authBindingId: realm.recipientAuthBindingId,
        displayName: 'Counterparty invitation recipient',
        principalId: realm.recipientPrincipalId,
        providerSubjectId: `counterparty-invitation-recipient-${realm.recipientPrincipalId}`,
      },
    ],
    storefront: { authBindingId: realm.storefrontAuthBindingId, principalId: realm.storefrontPrincipalId },
    tenantId: realm.tenantId,
    title: 'Counterparty invitation enrollment acceptance',
  });
