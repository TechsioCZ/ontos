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
import { encodeProductComposition, SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

export const internalSyncJobKey = 'integration.symmy.execute-symmy-job';
export const internalSyncActionKey = 'integration.symmy.admit-symmy-sync';
const groupAudience = 'commerce-customer-context';
const groupModule = 'commerce.customer-context';
const groupWrite = `${groupModule}.source-write`;
const groupRead = `${groupModule}.source-read`;
const inventoryWrite = 'commerce.inventory.source-write';
const inventoryRead = 'commerce.inventory.source-read';

const groupRules = [
  {
    declarationKey: `${groupModule}.customer-group.create`,
    entrypointKey: `${groupModule}.create-customer-group`,
    workloadKey: groupWrite,
  },
  {
    declarationKey: `${groupModule}.customer-group.update`,
    entrypointKey: `${groupModule}.update-customer-group`,
    workloadKey: groupWrite,
  },
  {
    declarationKey: `${groupModule}.customer-group-definition-source.read`,
    entrypointKey: `${groupModule}.api.customer-group-definition-source`,
    workloadKey: groupRead,
  },
].map((rule) => ({
  ...rule,
  audience: groupAudience,
  jobKey: internalSyncJobKey,
  legalEntityScope: 'required' as const,
  schemaVersion: '1',
  sourceActionKey: internalSyncActionKey,
}));
const inventoryRules = [
  {
    declarationKey: 'commerce.inventory.source-assertion.import',
    entrypointKey: 'commerce.inventory.import-source-assertion',
    workloadKey: inventoryWrite,
  },
  {
    declarationKey: 'commerce.inventory.inventory-source-import-receipt.read',
    entrypointKey: 'commerce.inventory.api.inventory-source-import-receipt',
    workloadKey: inventoryRead,
  },
].map((rule) => ({
  ...rule,
  audience: 'inventory',
  jobKey: internalSyncJobKey,
  legalEntityScope: 'forbidden' as const,
  schemaVersion: '1',
  sourceActionKey: internalSyncActionKey,
}));
const recoveryRules = [
  ...groupRules
    .filter(({ workloadKey }) => workloadKey === groupWrite)
    .map(({ entrypointKey }) => ({
      audience: groupAudience,
      declarationKey: `${groupModule}.customer-group-definition-source.read`,
      entrypointKey: `${groupModule}.api.customer-group-definition-source`,
      jobKey: internalSyncJobKey,
      legalEntityScope: 'required' as const,
      recoveryOf: { actionKey: entrypointKey, jobKey: internalSyncJobKey },
      schemaVersion: '1',
      sourceActionKey: internalSyncActionKey,
      workloadKey: groupRead,
    })),
  {
    audience: 'inventory',
    declarationKey: 'commerce.inventory.inventory-source-import-receipt.read',
    entrypointKey: 'commerce.inventory.api.inventory-source-import-receipt',
    jobKey: internalSyncJobKey,
    legalEntityScope: 'forbidden' as const,
    recoveryOf: { actionKey: 'commerce.inventory.import-source-assertion', jobKey: internalSyncJobKey },
    schemaVersion: '1',
    sourceActionKey: internalSyncActionKey,
    workloadKey: inventoryRead,
  },
];

type OwnedSyncDatabase = Effect.Success<ReturnType<typeof makeIsolatedNativeDatabaseFixture>>;

/** Genuine independent provider issuers, bound machine keys and exact finite native workload enrollment. */
export const prepareInternalSyncAuthority = Effect.fn('InternalC14Sync.prepareAuthority')(function* prepareAuthority(
  ownedDatabase: OwnedSyncDatabase,
  snapshot: ActiveApplicationCompositionSnapshot,
) {
  const admin = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
  const shell = yield* makeApiKeyGatewayNativeFixture({
    additionalRelaySources: [{ registeredWorkloads: [], sourceAppId: groupAudience }],
    ownedDatabase,
    productionGate: true,
    relaySource: {
      registeredWorkloads: [...groupRules, ...inventoryRules, ...recoveryRules],
      sourceAppId: 'symmy-integration',
    },
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
  if (shell.relaySourceProviderUserId === undefined) {
    return yield* new SymmyC14ProductFixtureUnavailable({ message: 'The actual Symmy module issuer was not prepared' });
  }
  const symmyModule = yield* seedCustomerFixtureProviderPrincipal(
    admin,
    tenantId,
    'service',
    shell.relaySourceProviderUserId,
  );
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
      yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status)
          values(${randomUUID()},${randomUUID()},${tenantId},${principalId},${workloadKey},'active')`;
    }
  }
  const ingressKey = yield* shell.issueFixtureProviderKey(integration);
  yield* bindCustomerFixtureProviderKey(admin, integration, ingressKey.providerKeyId);
  yield* ingressKey.acknowledgeBinding;
  const symmyKey = yield* shell.issueFixtureRelaySourceProviderKey(symmyModule);
  yield* bindCustomerFixtureProviderKey(admin, symmyModule, symmyKey.providerKeyId);
  yield* symmyKey.acknowledgeBinding;
  for (const provider of shell.additionalRelaySourceProviderUsers) {
    const issuer = yield* seedCustomerFixtureProviderPrincipal(admin, tenantId, 'service', provider.providerUserId);
    const key = yield* shell.issueFixtureModuleProviderKey({ ...issuer, sourceAppId: provider.sourceAppId });
    yield* bindCustomerFixtureProviderKey(admin, issuer, key.providerKeyId);
    yield* key.acknowledgeBinding;
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
      ONTOS_GATEWAY_MODULE_API_KEY: Redacted.value(symmyKey.secret),
      ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
      ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
    },
    ingressKey,
    integration,
    legalEntityId,
    shell,
    systemPrincipalId,
    tenantId,
  };
});
