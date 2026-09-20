import { eq } from 'drizzle-orm';
import { Context, Effect } from 'effect';
import { Pool } from 'pg';

import { acquirePoolResource } from '../../../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
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
import { layerTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import type { CounterpartyInvitationRealm } from './counterparty-invitation-acceptance.ts';

/**
 * The Core rows a Counterparty invitation acceptance needs: the Tenant, the three Principals the
 * scenario acts as, the Selling Legal Entity the journey names, the Commerce module state and the
 * two session bindings the gateway assertions present. Every row is removed again on scope close.
 */

const COMMERCE_MODULE_KEY = 'commerce.customer-context';

class CoreRealmDatabase extends Context.Service<CoreRealmDatabase, TestDatabaseFromPool<typeof coreRelations>>()(
  '@app/commerce-customer-context/tests/support/CoreRealmDatabase',
) {}

/** The Core rows a governed caller of this Tenant reads, plus the two session bindings. */
export const seedCounterpartyInvitationCoreRealm = Effect.fnUntraced(function* seedCounterpartyInvitationCoreRealm(
  realm: CounterpartyInvitationRealm,
) {
  const connections = yield* loadDatabaseConnectionPair();
  const adminPool = yield* acquirePoolResource(
    () => new Pool({ connectionString: connections.admin.connectionString, max: 2 }),
  );
  const admin = yield* CoreRealmDatabase.pipe(
    Effect.provide(layerTestDatabaseFromPool(CoreRealmDatabase, adminPool, coreRelations)),
  );
  const cleanup = Effect.gen(function* removeCoreRows() {
    for (const table of [
      outboxMessages,
      domainEvents,
      auditEvents,
      dataAccessEvents,
      evidenceReferences,
      actionInvocations,
      principalAuthBindings,
      tenantModuleStates,
      legalEntities,
      principals,
      tenants,
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
  yield* admin.insert(principalAuthBindings).values([
    {
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: realm.storefrontAuthBindingId,
      principalId: realm.storefrontPrincipalId,
      provider: 'commerce-portal-better-auth',
      providerSubjectId: `counterparty-invitation-storefront-${realm.storefrontPrincipalId}`,
      status: 'active',
      subjectType: 'user',
      tenantId: realm.tenantId,
    },
    {
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      principalAuthBindingId: realm.recipientAuthBindingId,
      principalId: realm.recipientPrincipalId,
      provider: 'commerce-portal-better-auth',
      providerSubjectId: `counterparty-invitation-recipient-${realm.recipientPrincipalId}`,
      status: 'active',
      subjectType: 'user',
      tenantId: realm.tenantId,
    },
  ]);
  return admin;
});
