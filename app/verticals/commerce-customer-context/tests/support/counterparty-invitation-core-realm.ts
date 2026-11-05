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

/** The Core rows a governed caller of this Tenant reads, plus the two session bindings. */
export const seedCounterpartyInvitationCoreRealm = Effect.fnUntraced(function* seedCounterpartyInvitationCoreRealm(
  realm: CounterpartyInvitationRealm,
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
    name: 'Counterparty invitation enrollment acceptance',
    slug: `counterparty-invitation-acceptance-${realm.tenantId}`,
    status: 'active',
    tenantId: realm.tenantId,
  });
  yield* admin.insert(principals).values([
    {
      displayName: 'Counterparty invitation storefront client',
      kind: 'system',
      principalId: realm.storefrontPrincipalId,
      status: 'active',
      tenantId: realm.tenantId,
    },
    {
      displayName: 'Counterparty access administrator',
      kind: 'human',
      principalId: realm.inviterPrincipalId,
      status: 'active',
      tenantId: realm.tenantId,
    },
    {
      displayName: 'Counterparty invitation recipient',
      kind: 'human',
      principalId: realm.recipientPrincipalId,
      status: 'active',
      tenantId: realm.tenantId,
    },
  ]);
  yield* admin.insert(legalEntities).values({
    legalEntityId: realm.legalEntityId,
    legalName: 'Counterparty invitation selling entity',
    registrationCountry: 'CZ',
    registrationNumber: `counterparty-invitation-${realm.legalEntityId}`,
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
      principalId: realm.storefrontPrincipalId,
      status: 'active',
      tenantId: realm.tenantId,
      workloadKey: 'commerce.storefront-client',
    })
    .onConflictDoNothing();
  yield* admin.insert(principalAuthBindings).values([
    {
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: realm.storefrontAuthBindingId,
      principalId: realm.storefrontPrincipalId,
      provider: PORTAL_PROVIDER,
      providerSubjectId: `counterparty-invitation-storefront-${realm.storefrontPrincipalId}`,
      status: 'active',
      subjectType: 'user',
      tenantId: realm.tenantId,
    },
    {
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: realm.inviterAuthBindingId,
      principalId: realm.inviterPrincipalId,
      provider: PORTAL_PROVIDER,
      providerSubjectId: `counterparty-invitation-inviter-${realm.inviterPrincipalId}`,
      status: 'active',
      subjectType: 'user',
      tenantId: realm.tenantId,
    },
    {
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: realm.recipientAuthBindingId,
      principalId: realm.recipientPrincipalId,
      provider: PORTAL_PROVIDER,
      providerSubjectId: `counterparty-invitation-recipient-${realm.recipientPrincipalId}`,
      status: 'active',
      subjectType: 'user',
      tenantId: realm.tenantId,
    },
  ]);
  return admin;
});
