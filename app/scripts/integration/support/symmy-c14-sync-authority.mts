import { randomUUID } from 'node:crypto';

import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { PgClient } from '@effect/sql-pg';
import { Effect, Redacted, Schema } from 'effect';

import {
  bindCustomerFixtureProviderKey,
  seedCustomerFixtureProviderPrincipal,
} from './symmy-c14-customer-native-authority.mts';
import { encodeProductComposition } from './symmy-c14-product-runtime.mts';

const internalSyncJobKey = 'integration.symmy.execute-symmy-job';
const groupModule = 'commerce.customer-context';
const groupWrite = `${groupModule}.source-write`;
const groupRead = `${groupModule}.source-read`;
const inventoryWrite = 'commerce.inventory.source-write';
const inventoryRead = 'commerce.inventory.source-read';

type OwnedSyncDatabase = Effect.Success<ReturnType<typeof makeIsolatedNativeDatabaseFixture>>;

/** A genuine provider issuer, platform-provisioned module keys and the tenant's native workload registrations. */
export const prepareInternalSyncAuthority = Effect.fn('InternalC14Sync.prepareAuthority')(function* prepareAuthority(
  ownedDatabase: OwnedSyncDatabase,
  snapshot: ActiveApplicationCompositionSnapshot,
) {
  const admin = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
  const callingOwners = ['catalog', 'commerce-customer-context'] as const;
  const shell = yield* makeApiKeyGatewayNativeFixture({
    additionalRelaySources: callingOwners.map((sourceAppId) => ({ sourceAppId })),
    ownedDatabase,
    productionGate: true,
    relaySource: { sourceAppId: 'symmy-integration' },
    snapshotJson: yield* encodeProductComposition(snapshot),
  });
  const tenantId = randomUUID();
  const legalEntityId = randomUUID();
  const tenantSlug = `internal-sync-${tenantId}`;
  yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale)
      values(${tenantId},'INTERNAL_C14 actual synchronous owner fixture',${tenantSlug},'active','en')`;
  yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status)
      values(${legalEntityId},${tenantId},'INTERNAL_C14 explicitly selected Group company','CZ','INTERNAL_C14_SYNC','active')`;
  const integration = yield* seedCustomerFixtureProviderPrincipal(admin, tenantId, 'integration', shell.providerUserId);
  const systemPrincipalId = randomUUID();
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name)
      values(${systemPrincipalId},${tenantId},'system','active','INTERNAL_C14 exact synchronous owner executor')`;
  for (const module of snapshot.composition.modules) {
    yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${module.moduleId},'active')`;
  }
  for (const [principalId, workloadKeys] of [
    [integration.principalId, ['integration.symmy-admit', groupWrite, groupRead, inventoryWrite, inventoryRead]],
    [systemPrincipalId, [internalSyncJobKey, groupWrite, groupRead, inventoryWrite, inventoryRead]],
  ] as const) {
    for (const workloadKey of workloadKeys) {
      const bindingId = randomUUID();
      yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status)
          values(${bindingId},${randomUUID()},${tenantId},${principalId},${workloadKey},'active')`;
      yield* admin`insert into core.access_workload_company_bindings(company_binding_id,incarnation,tenant_id,workload_binding_id,legal_entity_id,status)
          values(${randomUUID()},${randomUUID()},${tenantId},${bindingId},${legalEntityId},'active')`;
    }
  }
  const ingressKey = yield* shell.issueFixtureProviderKey(integration);
  yield* bindCustomerFixtureProviderKey(admin, integration, ingressKey.providerKeyId);
  yield* ingressKey.acknowledgeBinding;
  // Each calling owner's own module key, provisioned by the platform for its module principal as on every environment.
  const moduleKeys = new Map<string, Redacted.Redacted>([
    ['symmy-integration', (yield* shell.provisionRelaySource()).secret],
  ]);
  for (const appId of callingOwners) {
    moduleKeys.set(appId, (yield* shell.provisionModuleSource(appId)).secret);
  }
  const setupKey = yield* shell.issueFixtureSetupActorKey();
  const actualHuman = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      principalId: TrustedPrincipalContextSchema.fields.principalId,
      tenantId: TrustedPrincipalContextSchema.fields.tenantId,
    }),
  )({ principalId: integration.issuerPrincipalId, tenantId });
  yield* bindCustomerFixtureProviderKey(admin, actualHuman, setupKey.providerKeyId);
  yield* setupKey.acknowledgeBinding;
  return {
    admin,
    environment: {
      APP_ENV_PATH: '/dev/null',
      DATABASE_ADMIN_URL: ownedDatabase.connections.admin.connectionString,
      DATABASE_URL: ownedDatabase.connections.runtime.connectionString,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
      ONTOS_C14_TRACE_PROBLEMS: 'true',
      ONTOS_GATEWAY_ISSUER: shell.issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
      ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
    },
    ingressKey,
    integration,
    legalEntityId,
    moduleKeys,
    shell,
    systemPrincipalId,
    tenantId,
  };
});
